# Task: Add a PollUntil / RetryStep abstraction

## Summary

Every agent command that polls an AWS resource follows the exact same pattern:

```
Wait(N seconds) → Check status (SDK call) → Choice:
  - terminal success → continue
  - terminal failure → Fail
  - still in progress → loop back to Wait
```

This is 15-25 lines of boilerplate per polling loop, and the agent has 5 of them (deploy change set poll, deploy stack poll, destroy stack poll, drift detection poll, changeset readiness poll). A reusable `PollUntilStep` would collapse each to ~5 lines.

## Current boilerplate

```typescript
lonicSfn.Step.of(
  sfn.Wait.jsonata(this, 'WaitForDetection', {
    time: sfn.WaitTime.duration(cdk.Duration.seconds(10)),
  }),
  {},
)
.next((_, __, waitStep) =>
  lonicSfn.Step.of(
    new sfn.CustomState(this, 'CheckStatus', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:cloudformation:describeStackDriftDetectionStatus',
        Arguments: { StackDriftDetectionId: '{% $states.input.detectionId %}' },
        Output: { status: '{% $states.result.DetectionStatus %}', /* ... */ },
      },
    }),
    { status: new lonicSfn.StateOutput('status') },
  )
  .choice(sfn.Choice.jsonata(this, 'IsComplete', {}))
  .branch(
    o => sfn.Condition.jsonata(`{% ${o.status.expression} = "DETECTION_COMPLETE" %}`),
    () => continuation,
  )
  .branch(
    o => sfn.Condition.jsonata(`{% ${o.status.expression} = "DETECTION_FAILED" %}`),
    () => new sfn.Fail(this, 'Failed', { ... }),
  )
  .defaultBranch(() => waitStep)
  .build()
)
```

## Desired API

```typescript
// Option A: declarative config
lonicSfn.PollUntilStep.jsonata(this, 'PollDriftDetection', {
  interval: cdk.Duration.seconds(10),
  task: {
    resource: 'arn:aws:states:::aws-sdk:cloudformation:describeStackDriftDetectionStatus',
    arguments: { StackDriftDetectionId: '{% $states.input.detectionId %}' },
    output: { status: '{% $states.result.DetectionStatus %}', /* ... */ },
  },
  successWhen: '{% $states.result.status = "DETECTION_COMPLETE" %}',
  failWhen: '{% $states.result.status = "DETECTION_FAILED" %}',
  failError: 'DETECTION_FAILED',
  failCause: 'Drift detection failed',
  // anything else → loop
});

// Option B: wrap an existing step (more composable)
lonicSfn.PollUntilStep.wrap(this, 'PollDriftDetection', {
  interval: cdk.Duration.seconds(10),
  check: lonicSfn.Step.of(checkStatusState, { status }),
  successWhen: o => sfn.Condition.jsonata(`{% ${o.status.expression} = "DETECTION_COMPLETE" %}`),
  failWhen: o => sfn.Condition.jsonata(`{% ${o.status.expression} = "DETECTION_FAILED" %}`),
  failState: new sfn.Fail(this, 'Failed', { ... }),
});
```

Both options should return an `IStep` that can be chained with `.next()`.

## Use cases in the agent

| Command | What's polled | Interval | Success | Failure |
|---------|--------------|----------|---------|---------|
| deploy-stacks | Change set readiness | 5s | `CREATE_COMPLETE` | `FAILED` |
| deploy-stacks | Stack deploy status | 10s | `CREATE_COMPLETE` / `UPDATE_COMPLETE` | rollback/failed statuses |
| destroy-stacks | Stack deletion | 10s | stack gone (Catch) or `DELETE_COMPLETE` | `DELETE_FAILED` |
| detect-drift | Drift detection | 10s | `DETECTION_COMPLETE` | `DETECTION_FAILED` |
| get-changeset | Change set readiness | 5s | `CREATE_COMPLETE` | `FAILED` |

## Notes

- The step should support passing data through the loop (current output becomes next iteration's input)
- Consider a `maxAttempts` option for safety (fail after N iterations instead of infinite loop)
- Should compose with `VariableScope` — variables assigned before the poll should remain accessible inside and after
- Option A is simpler for SDK tasks; Option B is more flexible for wrapping existing CustomState/ConstructStep
