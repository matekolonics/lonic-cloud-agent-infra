# lonic Cloud Agent — Roadmap

Two repos, each with their own phases. The code repo (this one) implements business logic and trusts that environment variables and AWS resources are wired correctly. The infra repo deploys everything and wires it together.

---

## Code repo (lonic-cloud-agent-api)

### Phase 1: Foundation ✅

Cargo workspace, core types, event-reporter Lambda, callback client with bearer token auth, CI pipeline.

**Outcome:** The agent can receive events from Step Functions and report status back to the hosted backend.

**Env vars consumed:** `LONIC_CALLBACK_TOKEN_ARN`

---

### Phase 2: Health and version reporting ✅

- **Health check Lambda** — responds to a health check command with agent version, region, account ID
- **Version reporting** — agent reports its version on startup and in every status update
- Agent version embedded at build time via `env!("CARGO_PKG_VERSION")`
- Tracing spans with `commandId` correlation IDs on all handlers

**Outcome:** The hosted backend can verify agent connectivity and know what version is running.

**Env vars consumed:** none new (version is compile-time)

---

### Phase 3: Error enrichment and observability ✅

- **CloudFormation event log enrichment** — `CfnEventFetcher` fetches failure/rollback events from CloudFormation and attaches them to error reports when `stackName` is provided
- **Correlation IDs** — `commandId` propagated via `tracing::info_span` on all handlers, included in every log line
- **Structured logging** — shared `observability::init_tracing()` used by all Lambdas, JSON format, `RUST_LOG` env filter with `info` default

**Outcome:** Failures are debuggable from the hosted backend dashboard without the customer needing to check CloudWatch.

**Env vars consumed:** `RUST_LOG`

---

### Phase 4: Multi-region and agent pooling ✅

- **Agent identity** — `AGENT_ID` env var read by all Lambdas, included in every status update and health response
- **Registration model** — `AgentRegistration` payload (agent ID, version, region, account ID, capabilities) for registering with the hosted backend
- **Registration client** — `CallbackClient::send_registration()` POSTs registration to the backend's `/agent/register` endpoint using `LONIC_CALLBACK_BASE_URL`
- **Concurrency handling** — all Lambda code is stateless and safe for concurrent execution (Lambda handles concurrency natively)

**Outcome:** The code supports running as one of many agents across regions/accounts. Each agent identifies itself in every communication.

**Env vars consumed:** `AGENT_ID` (unique identifier assigned during setup), `LONIC_CALLBACK_BASE_URL` (for registration)

---

### Phase 5: Complete command types and output models ✅

- **Full command type enum** — all 11 command types: `synth-pipeline`, `synth-infrastructure`, `synth-cdk-project`, `discover-stacks`, `deploy-stacks`, `destroy-stacks`, `describe-stacks`, `detect-drift`, `get-changeset`, `start-execution`, `get-execution-status`
- **Typed output models** — `SynthOutput` (artifact URI, build ID, discovered stacks), `DescribeStacksOutput` (stack descriptions with status, outputs, parameters), `DiscoverStacksOutput` (stack name list)

**Outcome:** The shared contract between backend and agent covers all planned command types. Output models provide type safety for the most common response shapes.

**Env vars consumed:** none new

---

### Phase 6: CodeBuild log enrichment ✅

- **CodeBuild log fetcher** — `BuildLogFetcher` in `codebuild` module, calls `BatchGetBuilds` to fetch build status, failed phase details, and CloudWatch logs URL
- **Synth failure enrichment** — event-reporter attaches build log info when `buildId` is in the event payload and status is FAILED/TIMED_OUT
- **ErrorDetail extended** — `build_log` field added alongside existing `cfn_events` for structured error context

**Outcome:** Synth failures (CDK synth in CodeBuild) are debuggable from the dashboard, same as CloudFormation failures already are.

**Env vars consumed:** none new

**Infra must provide:** `codebuild:BatchGetBuilds` permission on event-reporter's IAM role. Synth state machines must include `buildId` in the event payload.

---

> **See [remaining-work.md](./remaining-work.md) for detailed design notes, dependency table, and future considerations.**

---

## Infra repo (lonic-cloud-agent-infra)

### Phase 1: Base agent stack

- API Gateway (HTTP API v2) with IAM authorization
- Lambda function for event-reporter (artifact from code repo Phase 1)
- IAM roles — scoped execution role, cross-account trust for the hosted backend
- Secrets Manager secret for callback bearer token
- Wire `LONIC_CALLBACK_TOKEN_ARN` env var to the Lambda
- One-click deployment via CloudFormation template or `cdk deploy`

**Depends on:** Code Phase 1 (event-reporter binary)

**Outcome:** A customer can deploy the agent into their AWS account.

---

### Phase 2: Step Functions state machines (MVP commands)

- **deploy-stacks** — triggers the built-in pipeline, reports progress via event-reporter
- **destroy-stacks** — calls CloudFormation `DeleteStack` in dependency order, reports progress
- **describe-stacks** — calls CloudFormation `DescribeStacks`, returns results
- **get-execution-status** — queries Step Functions execution status

API Gateway routes → state machines (service integration). Each state machine uses native SDK integrations for CloudFormation and invokes event-reporter as a Task state.

**Depends on:** Infra Phase 1

**Outcome:** The four MVP commands are executable end-to-end.

---

### Phase 3: Built-in deployment pipeline

- Reusable CDK/stack deployment pipeline using the library's `SynthStep` and `DeployStacksStep`
- Pipeline state change events wired to event-reporter Lambda
- This is the pipeline that `deploy-stacks` triggers

**Depends on:** Infra Phase 2, lonic-cdk-commons library

**Outcome:** The agent has a working pipeline that can synth and deploy CDK stacks.

---

### Phase 4: Health check, self-update, and runtime error reporting

- Health check Lambda deployment (artifact from code repo Phase 2) ✅
- Health check API Gateway route ✅
- **Self-update command** — `POST /commands/self-update` state machine that applies a raw CloudFormation template to the agent's own stack via change sets (create → poll → execute → poll). The backend synthesises the new agent template ahead of time and uploads it to S3 via the `get-upload-url` endpoint. No CDK pipeline involved — this is a direct CloudFormation update.
- **Runtime error reporting** — CloudWatch alarm on Lambda errors (event-reporter, health-check, get-upload-url) wired to an SNS topic → a lightweight error-reporter Lambda that POSTs to the backend callback URL. Catches the scenario where the event-reporter itself crashes (e.g. after a bad self-update), which would otherwise be a silent failure since the normal callback path is broken.

**Depends on:** Code Phase 2, Infra Phase 2

**Outcome:** The backend can health-check, remotely update agents, and detect runtime failures even when the normal callback path is broken.

---

### Phase 5: Multi-region and multi-account

- Support deploying agent stacks across multiple regions/accounts
- Agent registration mechanism (calls hosted backend on stack deploy/update)
- Optional SQS-based command queue for agent pooling
- Wire `AGENT_ID` env var

**Depends on:** Code Phase 4, Infra Phase 4

**Outcome:** Complex AWS topologies (Organizations, multi-region) are supported.

---

### Phase 6: Synth commands (CodeBuild)

- **synth-pipeline** — state machine that runs PipelineBuilder via `cdk synth` in CodeBuild
- **synth-infrastructure** — state machine that runs InfrastructureBuilder via `cdk synth` in CodeBuild
- **synth-cdk-project** — state machine that clones a customer repo and runs `cdk synth` in CodeBuild
- **discover-stacks** — state machine that runs `cdk ls` or parses `cdk.out` in CodeBuild
- CodeBuild projects with appropriate IAM roles and artifact bucket
- Event payloads must include `buildId` for log enrichment by event-reporter

**Depends on:** Infra Phase 3, Code Phase 6 (log enrichment), lonic-cdk-commons library

**Outcome:** The agent can synthesise CloudFormation templates from specs and customer CDK projects.

---

### Phase 7: Additional stack management commands

- **detect-drift** — state machine using native `DetectStackDrift` + polling `DescribeStackDriftDetectionStatus`
- **get-changeset** — state machine using native `CreateChangeSet` + `DescribeChangeSet`
- **start-execution** — state machine using native `StartExecution`

All native Step Functions SDK integrations, same pattern as Phase 2.

**Depends on:** Infra Phase 2

**Outcome:** Full stack management command set is available.

---

## Cross-repo dependency map

```
Code Phase 1 ✅ ──────────────► Infra Phase 1
                                    │
                                    ▼
                                Infra Phase 2 (MVP commands)
                                    │
                                    ├──────────────► Infra Phase 7 (drift, changeset, start-execution)
                                    ▼
Code Phase 2 ✅ ───────────────► Infra Phase 3 (pipeline)
Code Phase 3 ✅ (independent)       │
Code Phase 5 (command types)        ▼
                                Infra Phase 4 (health check + self-update)
                                    │
                                    ▼
Code Phase 4 ✅ ───────────────► Infra Phase 5 (multi-region)

Code Phase 6 (build log enrich) ──► Infra Phase 6 (synth/CodeBuild commands)
```

---

## Open questions

- **Offline mode:** Should the agent queue status updates when the backend is unreachable?
- **Custom pipelines:** How do customer-defined pipelines get registered and triggered?
- **Log filtering:** How do customers opt out of or filter sensitive log lines?
- **Drift detection:** Scheduled agent-side operation or on-demand command?
