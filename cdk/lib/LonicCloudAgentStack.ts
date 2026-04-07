import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { constructs as lonicConstructs } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { AgentApi } from './api/agent-api';
import { AgentRegistration } from './registration/agent-registration';
import { EventReporter } from './lambdas/event-reporter';
import { HealthCheck } from './lambdas/health-check';
import { DescribeStacksCommand } from './commands/describe-stacks';
import { GetExecutionStatusCommand } from './commands/get-execution-status';
import { DestroyStacksCommand } from './commands/destroy-stacks';
import { CommandQueue } from './commands/command-queue';
import { DeployStacksCommand } from './commands/deploy-stacks';
import { DetectDriftCommand } from './commands/detect-drift';
import { GetChangesetCommand } from './commands/get-changeset';
import { StartExecutionCommand } from './commands/start-execution';
import { SelfUpdateCommand } from './commands/self-update';
import { SynthCommand } from './commands/synth';
import { DeploymentPipeline } from './pipeline/deployment-pipeline';
import { GetUploadUrl } from './lambdas/get-upload-url';
import { RuntimeErrorReporter } from './lambdas/runtime-error-reporter';
import { ReviewPackager } from './review/review-packager';
import { ReviewResultHandler } from './review/review-result-handler';
import { ConfigureReview } from './review/configure-review';

export interface LonicCloudAgentStackProps extends cdk.StackProps {
  /** ARN of the IAM role in the lonic hosted backend account that is allowed to invoke this agent's API Gateway. */
  readonly backendRoleArn: string;
  /** Name of the public S3 bucket hosting agent artifacts. */
  readonly artifactBucket: string;
  /** Agent version to deploy (e.g. "0.3.0"). Determines the S3 key prefix for Lambda code. */
  readonly agentVersion: string;
  /** Base URL of the lonic hosted backend (e.g. "https://api.lonic.dev"). */
  readonly callbackBaseUrl: string;
}

export class LonicCloudAgentStack extends cdk.Stack {
  public readonly agentApi: AgentApi;
  public readonly registration: AgentRegistration;
  public readonly eventReporter: EventReporter;
  public readonly healthCheck: HealthCheck;
  public readonly commandQueue: CommandQueue;
  public readonly deploymentPipeline: DeploymentPipeline;
  public readonly getUploadUrl: GetUploadUrl;
  public readonly runtimeErrorReporter: RuntimeErrorReporter;

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

    const gitTokenParam = new cdk.CfnParameter(this, 'GitToken', {
      type: 'String',
      description: 'Secrets Manager ARN for the git provider access token (for cloning and posting review comments).',
      default: '',
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

    // --- Command Queue (SQS-backed async command dispatch) ---

    this.commandQueue = new CommandQueue(this, 'CommandQueue', {
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
      commandQueue: this.commandQueue,
    });

    new DeployStacksCommand(this, 'DeployStacks', {
      api: this.agentApi.restApi,
      commandQueue: this.commandQueue,
    });

    new DetectDriftCommand(this, 'DetectDrift', {
      api: this.agentApi.restApi,
      commandQueue: this.commandQueue,
    });

    new GetChangesetCommand(this, 'GetChangeset', {
      api: this.agentApi.restApi,
      commandQueue: this.commandQueue,
    });

    new StartExecutionCommand(this, 'StartExecution', {
      api: this.agentApi.restApi,
    });

    new SelfUpdateCommand(this, 'SelfUpdate', {
      api: this.agentApi.restApi,
      commandQueue: this.commandQueue,
    });

    // --- Deployment Pipeline (SynthStep → DeployStacksStep) ---

    this.deploymentPipeline = new DeploymentPipeline(this, 'DeploymentPipeline', {
      api: this.agentApi.restApi,
      commandQueue: this.commandQueue,
    });

    // --- Synth Commands (CodeBuild-based CDK synthesis) ---

    new SynthCommand(this, 'SynthPipeline', {
      api: this.agentApi.restApi,
      artifactsBucket: this.deploymentPipeline.artifactsBucket,
      routePath: 'synth-pipeline',
      stateMachineName: 'LonicAgent-SynthPipeline',
      commandQueue: this.commandQueue,
    });

    new SynthCommand(this, 'SynthInfrastructure', {
      api: this.agentApi.restApi,
      artifactsBucket: this.deploymentPipeline.artifactsBucket,
      routePath: 'synth-infrastructure',
      stateMachineName: 'LonicAgent-SynthInfrastructure',
      commandQueue: this.commandQueue,
    });

    new SynthCommand(this, 'SynthCdkProject', {
      api: this.agentApi.restApi,
      artifactsBucket: this.deploymentPipeline.artifactsBucket,
      routePath: 'synth-cdk-project',
      stateMachineName: 'LonicAgent-SynthCdkProject',
      commandQueue: this.commandQueue,
    });

    new SynthCommand(this, 'DiscoverStacks', {
      api: this.agentApi.restApi,
      artifactsBucket: this.deploymentPipeline.artifactsBucket,
      routePath: 'discover-stacks',
      stateMachineName: 'LonicAgent-DiscoverStacks',
      commandQueue: this.commandQueue,
    });

    // --- Upload URL generator (presigned S3 PUT for the pipeline artifacts bucket) ---

    this.getUploadUrl = new GetUploadUrl(this, 'GetUploadUrl', {
      api: this.agentApi.restApi,
      uploadBucket: this.deploymentPipeline.artifactsBucket,
    });

    // --- AI Code Review (EventBridge subscription + packaging + result handler) ---
    // Webhook reception and normalization are handled by the lonic-cdk-commons
    // webhook infrastructure singleton. Pull Request events arrive on EventBridge
    // with source "lonic.webhook" and detailType "Pull Request".

    const gitTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this, 'GitTokenSecret', gitTokenParam.valueAsString,
    );

    const reviewPackager = new ReviewPackager(this, 'ReviewPackager', {
      uploadBucket: this.deploymentPipeline.artifactsBucket,
      gitTokenSecret,
      callbackTokenSecret: this.registration.callbackTokenSecret,
      callbackBaseUrl: props.callbackBaseUrl,
      agentIdParam,
    });

    // Subscribe to Pull Request events from the commons webhook infrastructure
    new events.Rule(this, 'AiReviewPrRule', {
      description: 'Routes Pull Request webhook events to the AI review packager Lambda.',
      eventPattern: {
        source: ['lonic.webhook'],
        detailType: ['Pull Request'],
        detail: {
          action: ['opened', 'updated', 'reopened'],
        },
      },
      targets: [new targets.LambdaFunction(reviewPackager.fn)],
    });

    const reviewResultHandler = new ReviewResultHandler(this, 'ReviewResultHandler', {
      api: this.agentApi.restApi,
      gitTokenSecret,
    });

    // Webhook registration for AI review — uses the commons webhook
    // infrastructure singleton to create webhooks on git providers.
    const webhookInfra = lonicConstructs.webhook.WebhookInfrastructure.singleton(this);

    const configureReview = new ConfigureReview(this, 'ConfigureReview', {
      api: this.agentApi.restApi,
      gitTokenSecret,
      webhookApiUrl: webhookInfra.apiGatewayUrl,
      webhookTableName: webhookInfra.tableName,
      webhookTableArn: webhookInfra.tableArn,
    });

    // --- Runtime Error Reporting (independent alarm-based path to backend) ---

    this.runtimeErrorReporter = new RuntimeErrorReporter(this, 'RuntimeErrorReporter', {
      api: this.agentApi.restApi,
      monitoredFunctions: [
        this.eventReporter.fn,
        this.healthCheck.fn,
        this.getUploadUrl.fn,
        this.commandQueue.consumerFn,
        reviewPackager.fn,
        reviewResultHandler.fn,
        configureReview.fn,
      ],
      callbackTokenSecret: this.registration.callbackTokenSecret,
      callbackBaseUrl: props.callbackBaseUrl,
      agentIdParam,
    });

    // --- DLQ Alarm (wired to the runtime error reporter's SNS topic) ---

    const dlqAlarm = new cloudwatch.Alarm(this, 'CommandQueueDlqAlarm', {
      metric: this.commandQueue.dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'Messages in the command queue DLQ — commands failed to start execution',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cw_actions.SnsAction(this.runtimeErrorReporter.topic));
    dlqAlarm.addOkAction(new cw_actions.SnsAction(this.runtimeErrorReporter.topic));

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
