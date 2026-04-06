# Commons Task: Cross-Region CloudFormation Deploy Support

## Problem

`DeployStacksStep` (and the agent's raw `deploy-stacks` command) currently deploys all stacks to the region where the agent is running. However, a single CDK app can contain stacks targeting different regions — for example, CloudFront TLS certificates that **must** be created in `us-east-1` regardless of where the main application stacks live.

When `cdk synth` runs, it produces a `manifest.json` in the cloud assembly that specifies each stack's target environment:

```json
{
  "artifacts": {
    "CertificateStack": {
      "type": "aws:cloudformation:stack",
      "environment": "aws://123456789012/us-east-1",
      ...
    },
    "AppStack": {
      "type": "aws:cloudformation:stack",
      "environment": "aws://123456789012/eu-west-1",
      ...
    }
  }
}
```

This region information is available at deploy time but is not currently consumed by `DeployStacksStep` or the underlying CloudFormation SDK integrations.

## Proposed Solution

1. **SynthStep output enrichment** — include each stack's target `{ account, region }` in the `deploymentWaves` / `stackNames` output, read from the cloud assembly manifest.

2. **DeployStacksStep region-aware calls** — when creating/executing change sets and polling stack status, use the stack's target region to override the CloudFormation API endpoint. Step Functions native SDK integrations support an `Endpoint` parameter for this.

3. **Cross-account consideration** — if the target account differs from the current account, an AssumeRole step would be needed before CloudFormation calls. This is a separate, larger concern but worth keeping in mind during the region work.

## Impact

Without this, multi-region CDK apps deployed via the agent will fail — stacks targeting a non-local region will be created in the wrong region, or CloudFormation calls will fail to find them.

## Workaround

Deploy one agent per region. The backend routes each stack's deploy command to the agent in the correct region. This works but requires customers to deploy multiple agent stacks and the backend to maintain a region-to-agent mapping.
