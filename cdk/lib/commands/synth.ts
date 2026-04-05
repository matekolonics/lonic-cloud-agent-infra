import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { addStartExecutionRoute } from './api-sfn-integration';

export interface SynthCommandProps {
  /** API Gateway to add the route to. */
  readonly api: apigateway.RestApi;
  /** S3 bucket for source archives and synth artifacts. */
  readonly artifactsBucket: s3.IBucket;
  /** API route path under /commands/ (e.g. 'synth-cdk-project'). */
  readonly routePath: string;
  /** Step Functions state machine name. */
  readonly stateMachineName: string;
}

/**
 * Reusable construct for CDK synthesis commands. Runs `cdk synth` in CodeBuild
 * on a source archive uploaded to S3, and returns the synthesized artifacts,
 * stack names, and deployment waves.
 *
 * Uses `CdkSynthStep` from lonic-cdk-commons with DYNAMIC source mode —
 * the source archive URI is provided at execution time via `payload.sourceUri`.
 *
 * Used by: synth-pipeline, synth-infrastructure, synth-cdk-project, discover-stacks.
 *
 * Input:
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": {
 *     "sourceUri": "s3://bucket/uploads/<uuid>/source.zip"
 *   }
 * }
 * ```
 */
export class SynthCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: SynthCommandProps) {
    super(scope, id);

    const synthStep = new lonicSfn.tasks.CdkSynthStep(this, 'Synth', {
      source: { mode: 'DYNAMIC', bucket: props.artifactsBucket },
      artifactBucket: props.artifactsBucket,
      sourceUri: new lonicSfn.StateOutput('$states.input.payload.sourceUri'),
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(synthStep.startState),
      timeout: cdk.Duration.minutes(30),
      stateMachineName: props.stateMachineName,
    });

    addStartExecutionRoute(this, props.api, props.routePath, this.stateMachine);
  }
}
