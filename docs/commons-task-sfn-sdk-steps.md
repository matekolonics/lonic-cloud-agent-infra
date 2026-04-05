# Task: Add Step Functions SDK steps (StartExecution, DescribeExecution)

## Summary

The agent's `start-execution` and `get-execution-status` commands wrap single Step Functions SDK calls in raw `CustomState`. These are generic enough to belong in the library as typed steps, similar to how `CodeBuildStartBuild` wraps the CodeBuild SDK integration.

## Steps to add

### StartExecutionStep

Wraps `states:startExecution`. Accepts a state machine ARN and input, returns execution ARN and start date.

```typescript
lonicSfn.tasks.StartExecutionStep.jsonata(this, 'Start', {
  stateMachineArn: '{% $states.input.payload.stateMachineArn %}',
  input: '{% $string($states.input.payload.input) %}',
});
// outputs: { executionArn: StateOutput, startDate: StateOutput }
```

Note: this is different from `StepFunctionsStartExecution` (which uses the `.sync` or `.waitForTaskToken` integration pattern). This is the fire-and-forget SDK call that returns immediately with the execution ARN.

### DescribeExecutionStep

Wraps `states:describeExecution`. Accepts an execution ARN, returns full execution details.

```typescript
lonicSfn.tasks.DescribeExecutionStep.jsonata(this, 'Describe', {
  executionArn: '{% $states.input.payload.executionArn %}',
});
// outputs: { executionArn, status, startDate, stopDate, input, output: StateOutput }
```

## Priority

Low. These are simple single-state wrappers — the raw `CustomState` approach is only ~15 lines each. The value is mainly in discoverability and consistency with the rest of the library's typed step catalog.
