import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { pipeline, steps, sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addStartExecutionRoute } from '../commands/api-sfn-integration';

export interface DeploymentPipelineProps {
  /** API Gateway to add the deploy-pipeline route to. */
  readonly api: apigateway.RestApi;
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
 * and deploys all discovered stacks in dependency order via change sets.
 *
 * Uses `Pipeline.linear()` from lonic-cdk-commons with:
 * - **SynthStep** — runs `cdk synth` in CodeBuild (DYNAMIC source mode;
 *   the S3 URI of the source archive is provided at execution time via
 *   `payload.sourceUri`).
 * - **DeployStacksStep** — deploys stacks using the `deploymentWaves`
 *   output from SynthStep (sequential waves, parallel within each wave).
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

    this.pipeline = new pipeline.Pipeline(this, 'Pipeline', {
      head: (ctx) =>
        new steps.build.SynthStep(this, ctx, 'Synth', {
          source: { mode: 'DYNAMIC', bucket: ctx.getOrCreateArtifactsBucket() },
          sourceUri: new lonicSfn.StateOutput('$states.input.payload.sourceUri'),
          cdkAppDirectory: props.cdkAppDirectory,
          cdkCliVersion: props.cdkCliVersion,
        })
        .next((o, vars) =>
            new steps.deploy.DeployStacksStep(this, ctx, 'Deploy', {
              deploymentWaves: o.DeploymentWaves,
              ArtifactUri: vars.ArtifactUri,
            })
        ),
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
