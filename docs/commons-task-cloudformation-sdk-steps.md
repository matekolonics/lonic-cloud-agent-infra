# Task: Expose CloudFormation SDK steps as reusable typed constructs

## Summary

The library already has internal CloudFormation steps used by `DeployStacksStep` (`DoesStackExistStep`, `CreateChangeSetStep`, `GetChangeSetStatusStep`, `ExecuteChangeSetStep`, `GetStackStep`). However, these have hardcoded values (e.g., `ChangeSetName: 'test1'`) and aren't designed for external use.

The agent needs these same operations in multiple commands — deploy-stacks, destroy-stacks, detect-drift, get-changeset all make CloudFormation SDK calls. Currently every one of them is a raw `CustomState` with a hand-written `stateJson` block. Parameterized, reusable versions of these steps would reduce boilerplate and ensure consistency.

## Steps to expose

### Already internal (need parameterization)

| Step | Used by | What needs fixing |
|------|---------|-------------------|
| `DoesStackExistStep` | DeployStacksStep | Hardcoded values, should accept `stackName: Resolvable` |
| `CreateChangeSetStep` | DeployStacksStep | Hardcoded `ChangeSetName: 'test1'`, hardcoded TemplateURL pattern |
| `GetChangeSetStatusStep` | DeployStacksStep | Hardcoded `ChangeSetName` |
| `ExecuteChangeSetStep` | DeployStacksStep | Hardcoded `ChangeSetName` |
| `GetStackStep` | DeployStacksStep | Seems fine, just needs to be exported |

### New (not yet in the library)

| Step | Agent command | Description |
|------|-------------|-------------|
| `DeleteStackStep` | destroy-stacks | `cloudformation:deleteStack` |
| `DetectStackDriftStep` | detect-drift | `cloudformation:detectStackDrift` |
| `DescribeDriftDetectionStatusStep` | detect-drift | `cloudformation:describeStackDriftDetectionStatus` |
| `DescribeStackResourceDriftsStep` | detect-drift | `cloudformation:describeStackResourceDrifts` |
| `DeleteChangeSetStep` | get-changeset | `cloudformation:deleteChangeSet` |

## Desired API

Each step should:
- Accept parameters as `Resolvable` (Variable or StateOutput) so they work in any context
- Expose typed outputs as `StateOutput` fields
- Be wrapped in `Step.of()` already (or extend `ConstructStep`) so they chain with `.next()`
- Live under `sfn.tasks` or a new `sfn.aws` namespace

```typescript
// Example: detect drift with typed steps instead of raw CustomState
const definition = lonicSfn.tasks.DetectStackDriftStep.jsonata(this, 'DetectDrift', {
  stackName: '{% $states.input.payload.stackName %}',
})
.next((o) =>
  lonicSfn.PollUntilStep.wrap(this, 'PollDetection', {
    interval: cdk.Duration.seconds(10),
    check: lonicSfn.tasks.DescribeDriftDetectionStatusStep.jsonata(this, 'CheckStatus', {
      detectionId: o.detectionId,
    }),
    successWhen: s => sfn.Condition.jsonata(`{% ${s.detectionStatus.expression} = "DETECTION_COMPLETE" %}`),
    failWhen: s => sfn.Condition.jsonata(`{% ${s.detectionStatus.expression} = "DETECTION_FAILED" %}`),
  })
)
.next((o) =>
  lonicSfn.tasks.DescribeStackResourceDriftsStep.jsonata(this, 'GetDriftDetails', {
    stackName: '{% $states.input.payload.stackName %}',
    filters: ['MODIFIED', 'DELETED', 'NOT_CHECKED'],
  })
);
```

## Priority

Medium. The raw `CustomState` approach works fine — this is about reducing boilerplate and improving type safety. The `PollUntilStep` abstraction (separate task) would have more impact since it eliminates the most repetitive pattern.

If both land, the combination makes commands very concise:
- detect-drift goes from ~80 lines to ~20
- get-changeset goes from ~90 lines to ~25
- destroy-stacks processor goes from ~60 lines to ~15
