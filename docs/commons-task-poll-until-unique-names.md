# Commons Task: PollUntilStep should generate unique state names

## Problem

`PollUntilStep.wrap()` creates internal Step Functions states with fixed names (`Wait`, `Poll`, `PollComplete`, `Done`, `Failed`). When two `PollUntilStep` instances exist in the same state machine, their state names collide:

```
«DuplicateStateId» State with name 'Wait' occurs in both ...
```

The `id` parameter passed to `PollUntilStep.wrap(scope, id, ...)` creates a namespace `Construct`, but CDK uses only the construct `id` (not the full path) as the Step Functions state name.

## Current workaround

The second poll loop must be built manually (Wait → Check → Choice → loop back), duplicating the pattern that `PollUntilStep` encapsulates. See `self-update.ts` for an example.

## Proposed fix

Prefix internal state names with the `id` parameter:

```typescript
// Current (inside PollUntilStep.wrap):
sfn.Wait.jsonata(ns, 'Wait', ...)
sfn.Choice.jsonata(ns, 'Poll', ...)

// Proposed:
sfn.Wait.jsonata(ns, `${id}Wait`, ...)
sfn.Choice.jsonata(ns, `${id}Poll`, ...)
```

This ensures unique state names when multiple `PollUntilStep`s coexist in one state machine, while remaining backward-compatible for single-instance usage.

## Impact

Any state machine with two or more polling phases (e.g. self-update: poll change set ready → poll stack update complete) is currently blocked from using `PollUntilStep` for all phases.
