# Task: Support `.rejoin()` with loop-back branches in Choice

## Summary

When building polling loops with `.choice()`, the natural pattern is:

```
Check → Choice:
  branch: still in progress → loop back to Wait
  branch: failed → Fail
  default: success → continue to next step
```

Currently `.rejoin()` can't be used here because it calls `.next()` on all non-terminal branch ends — including the loop-back branch that's already wired to the Wait state. This causes a double-wiring error.

The workaround is `.build()` with the continuation embedded inside `.defaultBranch()`, which works but inverts the natural reading order (the happy path gets buried in the default branch, and the code nests deeper with each subsequent step).

## Current workaround

```typescript
.choice(sfn.Choice.jsonata(this, 'IsComplete', {}))
.branch(
  o => sfn.Condition.jsonata(`{% ${o.status.expression} = "IN_PROGRESS" %}`),
  () => waitStep,  // loop back — already has .next() wired
)
.branch(
  o => sfn.Condition.jsonata(`{% ${o.status.expression} = "FAILED" %}`),
  () => new sfn.Fail(this, 'Failed', { ... }),
)
// Happy path must go in defaultBranch because rejoin() would break
.defaultBranch(() =>
  // continuation is nested here instead of after the choice
  lonicSfn.Step.of(nextState, {})
)
.build()
```

## Desired behavior

```typescript
.choice(sfn.Choice.jsonata(this, 'IsComplete', {}))
.branch(
  o => sfn.Condition.jsonata(`{% ${o.status.expression} = "IN_PROGRESS" %}`),
  () => waitStep,  // loop back
)
.branch(
  o => sfn.Condition.jsonata(`{% ${o.status.expression} = "FAILED" %}`),
  () => new sfn.Fail(this, 'Failed', { ... }),
)
.defaultBranch(() => sfn.Pass.jsonata(this, 'Continue', {}))
.rejoin()  // should skip branches that are already wired (loop-back) or terminal (Fail)
.next(() => lonicSfn.Step.of(nextState, {}))
```

## Implementation idea

In `rejoin()`, before calling `.next()` on a branch end, check if:
1. The state is already terminal (`Fail`, `Succeed`) — skip
2. The state already has a `.next()` target wired (i.e., it's a loop-back) — skip
3. Otherwise — wire to the rejoin continuation

This could be detected by checking if the state implements `INextable` and whether its `next` has already been called (CDK tracks this internally via `_next` on `State`).

## Priority

Medium. The workaround is functional but makes complex state machines harder to read. Every polling loop in the agent uses this pattern (5 instances currently). The `PollUntilStep` abstraction would also solve this indirectly for the polling case, but this fix benefits any choice with mixed loop-back/terminal/continuation branches.
