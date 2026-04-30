import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { sfn as lonicSfn } from '@lonic/lonic-cdk-commons';
import { Construct } from 'constructs';
import { CommandQueue } from './command-queue';

const { JsonataExpr } = lonicSfn;

/** S3 archive supplied at runtime as `payload.sourceUri`. */
export interface S3SynthSource {
  readonly kind: 'S3';
}

/**
 * Git clone supplied at runtime as `payload.{repoUrl, ref, commitSha?, tokenSecretArn?, tokenSecretField?}`.
 * SourceStep DYNAMIC clones the repo, archives, uploads to S3; CdkSynthStep
 * then synthesises off that archive.
 */
export interface GitSynthSource {
  readonly kind: 'GIT';
}

export type SynthSource = S3SynthSource | GitSynthSource;

export interface SynthCommandProps {
  /** API Gateway to add the route to. */
  readonly api: apigateway.RestApi;
  /** S3 bucket for source archives and synth artifacts. */
  readonly artifactsBucket: s3.IBucket;
  /** API route path under /commands/ (e.g. 'synth-cdk-project'). */
  readonly routePath: string;
  /** Step Functions state machine name. */
  readonly stateMachineName: string;
  /** Shared command queue for async execution. */
  readonly commandQueue: CommandQueue;
  /** How the source archive is acquired. Defaults to S3 for backward compat. */
  readonly source?: SynthSource;
}

/**
 * Reusable construct for CDK synthesis commands.
 *
 * - **S3 mode** (default): runs `cdk synth` on a source archive at the URI in
 *   `payload.sourceUri`.
 * - **GIT mode**: clones the repo at `payload.repoUrl@payload.ref` (optional
 *   `payload.commitSha` pin), optionally authenticated with a PAT looked up
 *   from `payload.tokenSecretArn` (+ `payload.tokenSecretField` for JSON-keyed
 *   secrets), archives to S3, and runs `cdk synth` on it.
 *
 * Outputs `StackNames` and `DeploymentWaves` for downstream deploy pipelines.
 *
 * Used by: synth-pipeline, synth-infrastructure, synth-cdk-project, discover-stacks.
 *
 * **S3 mode input:**
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": { "sourceUri": "s3://bucket/uploads/<uuid>/source.zip" }
 * }
 * ```
 *
 * **GIT mode input:**
 * ```json
 * {
 *   "commandId": "cmd-abc123",
 *   "callbackUrl": "https://...",
 *   "payload": {
 *     "repoUrl": "https://github.com/customer/repo.git",
 *     "ref": "main",
 *     "commitSha": "abc...",                                // optional pin
 *     "tokenSecretArn": "arn:...:secret:lonic/git-credentials", // optional, omit for public repos
 *     "tokenSecretField": "github-org-foo"                  // optional, JSON key inside the secret
 *   }
 * }
 * ```
 */
export class SynthCommand extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: SynthCommandProps) {
    super(scope, id);

    const sourceMode = props.source?.kind ?? 'S3';

    let definitionStart: sfn.IChainable;

    if (sourceMode === 'S3') {
      const synthStep = new lonicSfn.tasks.CdkSynthStep(this, 'Synth', {
        source: { mode: 'DYNAMIC', bucket: props.artifactsBucket },
        artifactBucket: props.artifactsBucket,
        sourceUri: new lonicSfn.StateOutput('payload.sourceUri'),
      });
      definitionStart = synthStep.startState;
    } else {
      // SourceStep DYNAMIC reads its inputs at the top level of $states.input
      // (repoUrl, ref, commitSha, tokenSecretArn, tokenSecretField), but our
      // dispatch envelope places them under `payload`. Flatten via a Pass
      // state so the rest of the pipeline sees them where they're expected.
      const flattenInput = sfn.Pass.jsonata(this, 'FlattenGitInput', {
        outputs: {
          repoUrl:           new JsonataExpr('$states.input.payload.repoUrl').resolveJsonata(),
          ref:               new JsonataExpr('$states.input.payload.ref').resolveJsonata(),
          commitSha:         new JsonataExpr('($s := $states.input.payload.commitSha; $s ? $s : "")').resolveJsonata(),
          tokenSecretArn:    new JsonataExpr('($a := $states.input.payload.tokenSecretArn; $a ? $a : "")').resolveJsonata(),
          tokenSecretField:  new JsonataExpr('($f := $states.input.payload.tokenSecretField; $f ? $f : "")').resolveJsonata(),
        },
      });

      // Wildcard pattern matches any Secrets Manager secret under lonic/* in
      // this account. Covers both lonic-managed (lonic/git-credentials) and
      // customer-managed self-named secrets that follow the naming convention.
      const lonicSecretPattern = cdk.Stack.of(this).formatArn({
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: 'lonic/*',
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      });

      const sourceStep = new lonicSfn.tasks.SourceStep(this, 'Source', {
        mode: 'DYNAMIC',
        artifactBucket: props.artifactsBucket,
        tokenSecretArnPatterns: [lonicSecretPattern],
      });

      const synthStep = new lonicSfn.tasks.CdkSynthStep(this, 'Synth', {
        source: { mode: 'DYNAMIC', bucket: props.artifactsBucket },
        artifactBucket: props.artifactsBucket,
        sourceUri: sourceStep.ArtifactUri,
      });

      definitionStart = flattenInput
        .next(sourceStep.startState)
        .next(synthStep.startState);
    }

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definitionStart),
      queryLanguage: sfn.QueryLanguage.JSONATA,
      timeout: cdk.Duration.minutes(30),
      stateMachineName: props.stateMachineName,
    });

    props.commandQueue.addQueuedRoute(this, props.routePath, this.stateMachine);
  }
}
