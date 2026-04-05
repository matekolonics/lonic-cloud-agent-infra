import * as cdk from 'aws-cdk-lib/core';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { constructs as lonicConstructs } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { AgentApi } from './api/agent-api';
import { AgentRegistration } from './registration/agent-registration';
import { EventReporter } from './lambdas/event-reporter';
import { HealthCheck } from './lambdas/health-check';
import { DescribeStacksCommand } from './commands/describe-stacks';
import { GetExecutionStatusCommand } from './commands/get-execution-status';
import { DestroyStacksCommand } from './commands/destroy-stacks';
import { DeployStacksCommand } from './commands/deploy-stacks';
import { DetectDriftCommand } from './commands/detect-drift';
import { GetChangesetCommand } from './commands/get-changeset';
import { StartExecutionCommand } from './commands/start-execution';
import { DeploymentPipeline } from './pipeline/deployment-pipeline';

export interface LonicCloudAgentStackProps extends cdk.StackProps {
  /** ARN of the IAM role in the lonic hosted backend account that is allowed to invoke this agent's API Gateway. */
  readonly backendRoleArn: string;
  /** Name of the public S3 bucket hosting agent artifacts. */
  readonly artifactBucket: string;
  /** Agent version to deploy (e.g. "0.3.0"). Determines the S3 key prefix for Lambda code. */
  readonly agentVersion: string;
  /** Base URL of the lonic hosted backend (e.g. "https://api.lonic.dev"). */
  readonly callbackBaseUrl: string;
  /**
   * Path within the source archive where the CDK app lives (directory containing `cdk.json`).
   * Used by the deployment pipeline's SynthStep.
   * @default '.'
   */
  readonly cdkAppDirectory?: string;
  /**
   * CDK CLI version for the deployment pipeline's CodeBuild synth environment.
   * @default 'latest'
   */
  readonly cdkCliVersion?: string;
}

export class LonicCloudAgentStack extends cdk.Stack {
  public readonly agentApi: AgentApi;
  public readonly registration: AgentRegistration;
  public readonly eventReporter: EventReporter;
  public readonly healthCheck: HealthCheck;
  public readonly deploymentPipeline: DeploymentPipeline;

  constructor(scope: Construct, id: string, props: LonicCloudAgentStackProps) {
    super(scope, id, props);

    const artifactBucket = s3.Bucket.fromBucketName(this, 'ArtifactBucket', props.artifactBucket);
    const artifactPrefix = `agent/v${props.agentVersion}`;

    // --- CfnParameters (customer-specific, injected by the backend into the template) ---

    const agentIdParam = new cdk.CfnParameter(this, 'AgentId', {
      type: 'String',
      description: 'Unique identifier for this agent instance.',
      default: '{{AGENT_ID}}',
      noEcho: true,
    });

    const setupTokenParam = new cdk.CfnParameter(this, 'SetupToken', {
      type: 'String',
      description: 'Single-use setup token for agent registration. Issued by the lonic dashboard.',
      default: '{{SETUP_TOKEN}}',
      noEcho: true,
    });

    // --- API Gateway ---

    this.agentApi = new AgentApi(this, 'AgentApi', {
      backendRoleArn: props.backendRoleArn,
    });

    // --- Registration ---

    this.registration = new AgentRegistration(this, 'Registration', {
      agentIdParam,
      setupTokenParam,
      agentVersion: props.agentVersion,
      callbackBaseUrl: props.callbackBaseUrl,
    });

    // --- Event Reporter ---

    this.eventReporter = new EventReporter(this, 'EventReporter', {
      artifactBucket,
      artifactPrefix,
      agentVersion: props.agentVersion,
      agentIdParam,
      callbackBaseUrl: props.callbackBaseUrl,
      callbackTokenSecret: this.registration.callbackTokenSecret,
    });

    this.eventReporter.node.addDependency(this.registration);

    // EventBridge rule: route state machine completion events to event-reporter
    new events.Rule(this, 'CommandCompletionRule', {
      description: 'Routes Step Functions execution completion events to the event-reporter Lambda.',
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          status: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'],
        },
      },
      targets: [new targets.LambdaFunction(this.eventReporter.fn)],
    });

    // --- Health Check ---

    this.healthCheck = new HealthCheck(this, 'HealthCheck', {
      artifactBucket,
      artifactPrefix,
      agentVersion: props.agentVersion,
      agentIdParam,
      api: this.agentApi.restApi,
    });

    // --- Commands (Step Functions state machines) ---

    new DescribeStacksCommand(this, 'DescribeStacks', {
      api: this.agentApi.restApi,
    });

    new GetExecutionStatusCommand(this, 'GetExecutionStatus', {
      api: this.agentApi.restApi,
    });

    new DestroyStacksCommand(this, 'DestroyStacks', {
      api: this.agentApi.restApi,
    });

    new DeployStacksCommand(this, 'DeployStacks', {
      api: this.agentApi.restApi,
    });

    new DetectDriftCommand(this, 'DetectDrift', {
      api: this.agentApi.restApi,
    });

    new GetChangesetCommand(this, 'GetChangeset', {
      api: this.agentApi.restApi,
    });

    new StartExecutionCommand(this, 'StartExecution', {
      api: this.agentApi.restApi,
    });

    // --- Deployment Pipeline (SynthStep → DeployStacksStep) ---

    this.deploymentPipeline = new DeploymentPipeline(this, 'DeploymentPipeline', {
      api: this.agentApi.restApi,
      cdkAppDirectory: props.cdkAppDirectory,
      cdkCliVersion: props.cdkCliVersion,
    });

    // --- Outputs ---

    new lonicConstructs.stack.StackOutput(this, 'ApiUrl', {
      name: 'ApiUrl',
      value: this.agentApi.restApi.url,
    });

    new lonicConstructs.stack.StackOutput(this, 'ApiArn', {
      name: 'ApiArn',
      value: this.agentApi.restApi.arnForExecuteApi(),
    });

    new lonicConstructs.stack.StackOutput(this, 'CallbackTokenSecretArn', {
      name: 'CallbackTokenSecretArn',
      value: this.registration.callbackTokenSecret.secretArn,
    });
  }
}
