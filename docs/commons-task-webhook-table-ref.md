# Commons Task: Expose Webhook DynamoDB Table in WebhookInfrastructureRef

## Problem

`WebhookInfrastructureRef` currently only exposes `serviceToken` (manager Lambda ARN) and `apiGatewayUrl`. The DynamoDB registrations table is internal to the construct and cannot be accessed by consuming stacks.

This is a problem for the agent's `configure-review` command, which needs to register/deregister webhooks at runtime (not at CDK deploy time). It needs to write directly to the DynamoDB table because the manager Lambda is a raw CloudFormation Custom Resource handler that sends responses to `event.ResponseURL` — invoking it programmatically is not straightforward.

## Current workaround

The agent's configure-review Lambda discovers the table name at runtime by calling `lambda:GetFunctionConfiguration` on the manager Lambda and reading its `TABLE_NAME` environment variable. This requires:
- An extra IAM permission (`lambda:GetFunctionConfiguration`)
- A broad DynamoDB permission (`dynamodb:*Item` on `arn:*:dynamodb:*:*:table/*`) since the table ARN is unknown at CDK time
- An additional API call on every cold start

## Proposed change

Add `tableName` and `tableArn` to `WebhookInfrastructureRef`:

```typescript
export interface WebhookInfrastructureRef {
    readonly serviceToken: string;
    readonly apiGatewayUrl: string;
    readonly tableName: string;  // NEW
    readonly tableArn: string;   // NEW
}
```

Update the singleton SSM parameter to include all four values (pipe-delimited) instead of two. The `singleton()` method would split and return all fields.

## Impact

This would let the agent (and any future consumer that needs runtime webhook management) scope DynamoDB permissions tightly and avoid the `GetFunctionConfiguration` workaround.

## Files to change

- `cdk/lib/constructs/webhook/webhook-infrastructure.ts` — add `tableName`/`tableArn` to the ref, update `singleton()` SSM value format
- `cdk/lib/constructs/index.ts` — no change (already exports the webhook module)
