# Remaining Work — Code Repo

What still needs to happen in this repo, based on [agent-design.md](./agent-design.md) and the [library-and-service-overview.md](./library-and-service-overview.md).

---

## 1. Complete the command type enum

The `CommandType` enum currently has 4 variants. The agent design defines 11 distinct command types. The enum is the shared contract between the backend and the agent — even commands executed entirely via native Step Functions SDK integrations need to be represented here.

**Add:**

| Command | What it does | Executed by |
|---------|-------------|-------------|
| `synth-pipeline` | Run PipelineBuilder via `cdk synth` | Step Functions → CodeBuild (infra) |
| `synth-infrastructure` | Run InfrastructureBuilder via `cdk synth` | Step Functions → CodeBuild (infra) |
| `synth-cdk-project` | Clone customer repo, run `cdk synth` | Step Functions → CodeBuild (infra) |
| `discover-stacks` | Run `cdk ls` or parse `cdk.out` | Step Functions → CodeBuild (infra) |
| `detect-drift` | CloudFormation drift detection | Step Functions → native SDK (infra) |
| `get-changeset` | Create change set without executing | Step Functions → native SDK (infra) |
| `start-execution` | Start a Step Functions execution | Step Functions → native SDK (infra) |

**Already implemented:** `deploy-stacks`, `destroy-stacks`, `describe-stacks`, `get-execution-status`.

None of these new commands require new Lambda code in this repo. They are all handled by Step Functions state machines (infra repo) using either native SDK integrations or CodeBuild. The event-reporter Lambda already handles status reporting for all of them — it receives a generic `TaskCallbackEvent` from any state machine.

---

## 2. Typed payload models (optional, recommended)

Currently `CommandEnvelope.payload` is `serde_json::Value`. This is fine for the agent since Lambdas here don't interpret most payloads. However, some payloads flow through the event-reporter as `outputs` and having typed models improves documentation and validation.

**Candidates for typed models:**

- `DescribeStacksOutput` — the output shape when `describe-stacks` completes (stack name, status, outputs, parameters). The event-reporter forwards this as `outputs` in the status update.
- `DriftDetectionOutput` — drift status, drifted resources.
- `ChangesetOutput` — change set ID, changes summary.
- `SynthOutput` — S3 URI of the synthesised CloudFormation templates.

These are **output models**, not input payloads. The agent doesn't parse command inputs (Step Functions does that). But it does forward outputs from Step Functions task states through event-reporter to the backend.

**Recommendation:** Start with `DescribeStacksOutput` and `SynthOutput` since those are the most likely to be used first. Add others as the infra repo implements the corresponding state machines.

---

## 3. Event-reporter enrichment by command type

The event-reporter currently enriches errors with CloudFormation events when `stackName` is provided. As more command types are added, different enrichment strategies may be useful:

- **Synth failures** — attach CodeBuild build logs (build ID in the event payload, fetch from CloudWatch Logs or CodeBuild API)
- **Drift detection** — attach the drift details as structured data in the status update
- **Changeset** — attach the change list as structured output

This is incremental work that should happen as each command type is implemented in the infra repo. The pattern is already established: check event fields, fetch additional context from AWS APIs, attach to the status update.

**New dependencies for enrichment:**
- `aws-sdk-codebuild` — for fetching build logs on synth failures
- `aws-sdk-cloudwatch-logs` — for streaming build log output (optional, CodeBuild API may suffice)

---

## 4. What does NOT belong in this repo

These are infra repo concerns, listed here to avoid scope creep:

- **Step Functions state machines** — all command execution flows (synth, deploy, destroy, describe, drift, changeset) are state machines in the infra repo
- **CodeBuild projects** — synth commands run CDK in CodeBuild, configured by the infra repo
- **API Gateway routes** — routing commands to the right state machine
- **IAM roles and policies** — execution roles, cross-account trust
- **Self-update mechanism** — a state machine that updates the agent's own CloudFormation stack
- **S3 buckets** — artifact storage for synth output, source archives
- **Wiring env vars** — `AGENT_ID`, `LONIC_CALLBACK_TOKEN_ARN`, `LONIC_CALLBACK_BASE_URL`, etc.

---

## 5. Implementation order

### Phase 5: Complete command types and output models

1. Add all missing `CommandType` variants to the enum
2. Add `SynthOutput` model (S3 URI of synthesised templates)
3. Add `DescribeStacksOutput` model (stack status, outputs, parameters)
4. Update tests (roundtrip all variants, serde tests for new models)

**Infra dependency:** None. These are just models.

### Phase 6: CodeBuild log enrichment

1. Add `aws-sdk-codebuild` dependency
2. Create `codebuild` module in agent-core (similar pattern to `cfn` module)
3. `BuildLogFetcher::fetch_build_logs(build_id, tail_lines)` — fetches recent log lines from a CodeBuild build
4. Update event-reporter to enrich synth failures with build logs when `buildId` is in the event payload
5. Tests with mocked responses

**Infra dependency:** Synth state machines must include `buildId` in the event payload sent to event-reporter. The event-reporter Lambda's IAM role must allow `codebuild:BatchGetBuilds` and optionally `logs:GetLogEvents`.

### Future: Additional output models and enrichment

Add as each command type is implemented in the infra repo:
- `DriftDetectionOutput` + drift enrichment (when `detect-drift` state machine exists)
- `ChangesetOutput` (when `get-changeset` state machine exists)

---

## Dependency summary

| This repo provides | Infra repo must provide |
|---|---|
| Command type enum (shared contract) | State machines that execute each command type |
| Event-reporter Lambda binary | Task states that invoke event-reporter with the right payload shape |
| Health-check Lambda binary | Health check API Gateway route + Lambda deployment |
| Callback client + bearer token auth | Secrets Manager secret for the token, `LONIC_CALLBACK_TOKEN_ARN` env var |
| Agent registration model + client | `AGENT_ID` and `LONIC_CALLBACK_BASE_URL` env vars |
| CFN event enrichment | `cloudformation:DescribeStackEvents` permission on the Lambda role |
| CodeBuild log enrichment (Phase 6) | `codebuild:BatchGetBuilds` permission, `buildId` in event payload |
| Output models (typed shapes) | State machines must produce outputs matching these shapes |
