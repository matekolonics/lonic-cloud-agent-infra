import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import {pipeline, sfn as lonicSfn, steps} from '@lonic/lonic-cdk-commons';
import {Construct} from 'constructs';
import {CommandQueue} from '../commands/command-queue';
import {SingletonScope} from "@lonic/lonic-cdk-commons/lib/constructs/registry";

export interface DeploymentPipelineProps {
  /** API Gateway to add the deploy-pipeline route to. */
  readonly api: apigateway.RestApi;
  /** Shared command queue for async execution. */
  readonly commandQueue: CommandQueue;
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
  /** The S3 bucket used for pipeline artifacts (synth output, source uploads). */
  public artifactsBucket!: s3.IBucket;

  constructor(scope: Construct, id: string, props: DeploymentPipelineProps) {
    super(scope, id);

    this.pipeline = new pipeline.Pipeline(this, 'Pipeline', {
      head: (ctx) => {
        this.artifactsBucket = ctx.getOrCreateArtifactsBucket();
        return new steps.build.SynthStep(this, ctx, 'Synth', {
          source: { mode: 'DYNAMIC', bucket: this.artifactsBucket },
          sourceUri: new lonicSfn.StateOutput('$states.input.payload.sourceUri'),
        })
        .next((o, vars) =>
            new steps.deploy.DeployStacksStep(this, ctx, 'Deploy', {
              deploymentWaves: o.DeploymentWaves,
              ArtifactUri: vars.ArtifactUri,
            })
        );
      },
      singletonScope: SingletonScope.Stack,
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

    props.commandQueue.addQueuedRoute(this, 'deploy-pipeline', this.pipeline.stateMachine);
  }
}
