# Task: Support dynamic stack deployment in DeployStacksStep

## Summary

`DeployStacksStep` currently requires `stacks: string[]` at CDK synth time. This makes it impossible to build a single Pipeline that synths a CDK app and deploys all discovered stacks — the stack names aren't known until the SynthStep runs in CodeBuild.

Add support for deploying all stacks from a synth output, using the `DeploymentWaves` export to handle cross-stack dependency ordering automatically.

## Context

The lonic cloud agent needs a deployment pipeline that:
1. Runs `cdk synth` via SynthStep (produces templates + discovers stacks)
2. Deploys all discovered stacks in dependency order

Today this requires the backend to orchestrate synth and deploy as two separate commands because `DeployStacksStep` can't consume runtime stack lists. A single Pipeline that handles the full flow would be simpler and more reliable.

## Current behavior

```typescript
// Stacks must be known at synth time — baked into the state machine definition
new DeployStacksStep(this, ctx, 'Deploy', {
  stacks: ['NetworkStack', 'AppStack'],  // static string[]
  ArtifactUri: synth.ArtifactUri,
});
```

The Map state inside DeployStacksStep iterates over a JSONata literal array of stack names.

## Desired behavior

```typescript
// Option A: consume DeploymentWaves directly
new DeployStacksStep(this, ctx, 'Deploy', {
  deploymentWaves: synth.DeploymentWaves,  // Variable — 2D array from synth
  ArtifactUri: synth.ArtifactUri,
});

// Option B: accept a Variable for stacks (flat list, deployed in parallel)
new DeployStacksStep(this, ctx, 'Deploy', {
  stacks: synth.StackNames,  // Variable instead of string[]
  ArtifactUri: synth.ArtifactUri,
});
```

Option A is preferred because it preserves dependency ordering. Option B is simpler but loses wave information (all stacks deployed in parallel).

## Implementation notes

### DeploymentWaves format

SynthStep's `CdkSynthProject` exports `DEPLOYMENT_WAVES` as a JSON string:
```json
[["NetworkStack"], ["AppStack", "WorkerStack"], ["MonitoringStack"]]
```

Each inner array is a wave of stacks deployable in parallel. Waves execute sequentially: wave N starts only after all stacks in wave N-1 succeed.

### State machine structure for Option A

The current DeployStacksStep uses a single Map state (parallel over stacks). To support waves, it would need:

```
Outer Map (maxConcurrency: 1, sequential over waves)
  └── Inner Map (parallel over stacks in the wave)
        └── Existing per-stack deployment flow:
              DoesStackExist → CreateChangeSet → Poll → Execute → Poll
```

- **Outer Map items**: `deploymentWaves` variable (2D array)
- **Inner Map items**: `$states.context.Map.Item.Value` (current wave's stack list)
- **ItemSelector** for inner Map needs `ArtifactUri` threaded through

### Props changes

```typescript
export interface DeployStacksStepProps {
  // Existing — static stack list, all deployed in parallel
  readonly stacks?: string[];

  // New — runtime waves from SynthStep, deployed sequentially per wave
  readonly deploymentWaves?: Variable;

  readonly ArtifactUri: Variable;
  readonly artifactBucket?: cdk.aws_s3.IBucket;
}
```

Exactly one of `stacks` or `deploymentWaves` must be provided. Validate at construct time.

### Spec support (PipelineBuilder)

The `deploy-stacks` step definition in PipelineSpec should support an `all` mode:

```json
{
  "type": "deploy-stacks",
  "id": "DeployAll",
  "props": {
    "all": true
  }
}
```

When `all: true`, the PipelineBuilder wires `deploymentWaves` from the preceding SynthStep automatically (similar to how `$stepRef` resolves outputs today). The `stacks` array prop remains supported for explicit stack lists.

### IAM and grantPermissions

No changes needed — the existing CloudFormation + S3 grants are resource-wildcard already.

## Acceptance criteria

- [ ] `DeployStacksStep` accepts `deploymentWaves: Variable` as an alternative to `stacks: string[]`
- [ ] Waves execute sequentially; stacks within a wave execute in parallel
- [ ] A failed stack in any wave fails the entire step (existing behavior preserved)
- [ ] `PipelineBuilder` supports `"all": true` on `deploy-stacks` steps
- [ ] `Pipeline.linear(ctx => [synth, deploy])` works end-to-end with dynamic stacks
- [ ] Existing `stacks: string[]` behavior is unchanged (backward compatible)
