import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { pipeline, steps, sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addStartExecutionRoute } from '../commands/api-sfn-integration';

export interface DeploymentPipelineProps {
  /** API Gateway to add the deploy-pipeline route to. */
  readonly api: apigateway.RestApi;
  /** CloudFormation stack names to deploy. All stacks in the list are deployed in parallel. */
  readonly stacks: string[];
  /**
   * Path within the source archive where the CDK app lives (directory containing `cdk.json`).
   * @default '.'
   */
  readonly cdkAppDirectory?: string;
  /**
   * CDK CLI version to install in the CodeBuild synth environment.
   * @default 'latest'
   */
  readonly cdkCliVersion?: string;
}

/**
 * A deployment pipeline that synthesizes a CDK application in CodeBuild
 * and deploys the resulting CloudFormation stacks via change sets.
 *
 * Uses `Pipeline.linear()` from lonic-cdk-commons with:
 * - **SynthStep** — runs `cdk synth` in CodeBuild (DYNAMIC source mode;
 *   the S3 URI of the source archive is provided at execution time via
 *   `payload.sourceUri`).
 * - **DeployStacksStep** — deploys all stacks in parallel using the
 *   full change set flow (exists check → create → poll → execute → poll).
 *
 * Exposed at `POST /commands/deploy-pipeline` with IAM auth.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": {
 *     "sourceUri": "s3://bucket/path/source.zip"
 *   }
 * }
 * ```
 */
export class DeploymentPipeline extends Construct {
  public readonly pipeline: pipeline.Pipeline;

  constructor(scope: Construct, id: string, props: DeploymentPipelineProps) {
    super(scope, id);

    this.pipeline = pipeline.Pipeline.linear(this, 'Pipeline', (ctx) => {
      const synth = new steps.build.SynthStep(this, ctx, 'Synth', {
        source: { mode: 'DYNAMIC', bucket: ctx.getOrCreateArtifactsBucket() },
        sourceUri: new lonicSfn.StateOutput('$states.input.payload.sourceUri'),
        cdkAppDirectory: props.cdkAppDirectory,
        cdkCliVersion: props.cdkCliVersion,
      });

      const deploy = new steps.deploy.DeployStacksStep(this, ctx, 'Deploy', {
        stacks: props.stacks,
        ArtifactUri: synth.ArtifactUri,
      });

      return [synth, deploy];
    }, {
      stateMachineName: 'LonicAgent-DeploymentPipeline',
      timeout: cdk.Duration.minutes(60),
    });

    // Stacks being deployed may create any resource — grant via CalledVia condition
    this.pipeline.stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['*'],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': {
          'aws:CalledVia': ['cloudformation.amazonaws.com'],
        },
      },
    }));

    addStartExecutionRoute(this, props.api, 'deploy-pipeline', this.pipeline.stateMachine);
  }
}
