# Agent ↔ Backend Command Wiring — Status

Tracks the state of every command route exposed by the agent's API Gateway and
the corresponding dispatch on the backend. A row is "wired" when the agent has
a working route AND the backend dispatches to it for a real user-facing flow.

Last surveyed against:
- agent: `cdk/lib/LonicCloudAgentStack.ts`, `cdk/lib/commands/*`, `cdk/lib/pipeline/*`, `cdk/lib/review/*`, `cdk/lib/lambdas/*`
- backend (`lonic-cloud-api`): `lambdas/api-*/**/*.rs`, searching for `dispatch_to_agent` / `send_command` / `/v1/commands/`

---

## ✅ Wired (working end-to-end, payload contract honoured)

| Command | Agent route | Dispatch type | Backend caller(s) |
|---|---|---|---|
| `self-update` | queued | sync | `api-agents` self-update flow |
| `describe-stacks` | sync | sync | several (verified via `/v1/commands/describe-stacks` URL string) |
| `review-result` | sync direct (Lambda) | **backend → agent** | `api-reviews` posts AI review result back to the agent so the agent can comment on the PR |

(Anything more sophisticated than these three flows hits one of the gaps below.)

---

## ⚠️ Half-wired (route exists on both sides, but payload contract is broken)

The backend dispatches commands but doesn't populate the fields the agent's
state machine reads — and/or the source S3 archive isn't reachable from the
agent's IAM scope. These flows fail at runtime even though the route 200s.

### `synth-infrastructure` — missing `payload.sourceUri`

- **Where:** `lonic-cloud-api/lambdas/api-deployments/src/deployments.rs:262-270`
- **Sent payload:** `{ appId, instanceId, infraVersion }`
- **Agent expects:** `{ sourceUri }` (used as `LONIC_SOURCE_URI` env override → CodeBuild downloads it in install phase)
- **Failure mode:** CodeBuild starts, runs `aws s3 cp "" /tmp/lonic-source.zip` with no override set → silent failure or non-zero exit; build never produces synth output.
- **Data exists:** `InfraDefinition.source_uri` is populated by `api-apps/upload.rs` and stored on the DDB record. It just isn't looked up before dispatch.
- **Fix:** in `trigger_deployment`, query `InfraDefinition` for `(appId, infraVersion)` and inject `sourceUri` into `synth.payload` before starting the orchestration. Same DDB lookup pattern as `get_latest_infra_version`.

### `synth-infrastructure` — cross-account S3 read not configured (separate from the missing-field issue)

Even with `sourceUri` populated, the agent's CodeBuild role can only read
from the agent's own `artifactsBucket` (granted at `cdk-synth-project.ts:564`).
Today `source_uri` points at `s3://<backend-specs-bucket>/uploads/<orgId>/<appId>/<uploadId>/source.zip`,
which lives in the lonic backend account. The customer's CodeBuild has no IAM
to that bucket. See the **Source archive location** section below for the design choice.

### `deploy-stacks` — missing `payload.stackNames` and `payload.templateBaseUrl`

- **Where:** `lonic-cloud-api/lambdas/api-deployments/src/deployments.rs:271-279` and the orchestrator state machine in `cdk/lib/stacks/api/DeploymentsApiStack.ts:140-143`.
- **Sent payload:** `{ appId, instanceId, infraVersion }`
- **Agent expects:** `{ stackNames: string[], templateBaseUrl: string }` (the Map's `items` JSONata at `deploy-stacks.ts:139` and the per-stack `templateUrl` at `deploy-stacks.ts:81-83`).
- **Failure mode:** even if synth ran, the deploy state machine sees `$states.input.payload.stackNames` as undefined → empty Map iteration → no-op. `templateBaseUrl` undefined → broken `templateUrl` strings.
- **Root cause:** `synthStep` outputs to `$.synthResult` and `deployStep` reads `$.deploy.payload`, but there's no Pass / enriching step between them in the orchestrator that copies `synthResult.outputs.stackNames` and `synthResult.outputs.artifactUri` into `deploy.payload.stackNames` / `templateBaseUrl`.
- **Fix options:**
  - **(a) Add a Pass state** between `synthStep` and `deployStep` that merges synth output into deploy input.
  - **(b) Switch the orchestrator to dispatch `deploy-pipeline`** (the agent-side combined synth+deploy state machine) and drop the two-step orchestration. Simpler, but loses per-step granularity in the deployment record.

### `provision` — agent has no matching route

(Already covered earlier — `api-instances/instances.rs:273` dispatches but no agent route exists.)

**Fix options:**
- [ ] Add a `provision` state machine on the agent (same shape as `deploy-pipeline` — synth + deploy in one flow), accepting `{ instanceId, appId }` and resolving the source archive internally.
- [ ] Or: change `api-instances` to dispatch `synth-infrastructure` then `deploy-stacks` separately, mirroring how `api-pipelines` orchestrates pipeline steps. Note this hits the half-wired issues above too — they need fixing first.

### Other dispatches with unverified payload contracts

These backend → agent dispatches haven't been audited line-by-line against the
agent's state-machine input expectations. Worth verifying before declaring
"wired":

- `destroy-stacks` (`api-instances/instances.rs:534`) — agent expects `payload.stackNames`. Likely OK if the instance record carries them, but verify.
- `detect-drift` (`api-instances/instances.rs:625`) — agent expects `payload.stackName` (singular). Verify.
- `get-changeset`, `start-execution` from `api-pipelines/executions.rs` — agent expects `stackName`, `templateUrl`, `changeSetType` for `get-changeset`; `stateMachineArn`, `input` for `start-execution`. Verify each.

---

## 🟡 Orphan routes (agent exposes them, no backend caller)

These cost nothing while idle, but every route grants IAM permissions to the
`LonicCloud-BackendRole` and adds noise to API Gateway / state-machine lists.
Either wire them up or delete them.

| Command | Agent state machine / handler | Notes |
|---|---|---|
| `synth-pipeline` | `LonicAgent-SynthPipeline` (identical body to `synth-infrastructure`) | Intended for `PipelineBuilder` specs. Backend has no caller yet. |
| `synth-cdk-project` | `LonicAgent-SynthCdkProject` (identical body) | Intended for raw CDK projects (no Lonic spec). No caller. |
| `discover-stacks` | `LonicAgent-DiscoverStacks` (identical body) | Intended as a probe — run `cdk synth` and return `StackNames` / `DeploymentWaves` only. No caller. |
| `deploy-pipeline` | `LonicAgent-DeploymentPipeline` (chained synth → deploy) | The end-to-end variant. Backend prefers calling `synth-infrastructure` and `deploy-stacks` as separate pipeline steps, so this is unused today. |
| `get-execution-status` | EXPRESS SFN | The polling counterpart to `start-execution`. Wired-up dispatch only sends `start-execution`; nothing currently polls. |
| `configure-review` | direct Lambda | Wired but consumer path not traced — may be hit from frontend or other repos. **Verify before deleting.** |
| `get-upload-url` | direct Lambda (presigned S3 PUT) | Same — likely called from frontend / other repos for source-archive uploads. **Verify before deleting.** |

**Action items:**
- [ ] Decide each: wire it on the backend, or delete it from the agent.
- [ ] For `configure-review` / `get-upload-url`, grep the lonic-cloud-api and frontend repos before declaring orphaned.

---

## 🟢 Identical-body `SynthCommand` instances — consolidation question

`synth-pipeline`, `synth-infrastructure`, `synth-cdk-project`, and `discover-stacks`
all instantiate the same `SynthCommand` class with the same `CdkSynthStep` body.
The only differences are the API route path and state-machine name.

**Trade-off:**
- *Keep separate:* clearer audit trail in CloudWatch / SFN execution lists; each can grow its own pre/post steps later (e.g. `discover-stacks` could skip artifact upload; `synth-pipeline` could validate the spec first); per-route IAM scoping.
- *Collapse to one:* less duplication, single state machine to maintain. Differentiate via a `kind` field on the input.

**Action item:**
- [ ] Pick one direction once we know whether these will diverge in behaviour.

---

## Source archive location — design choice

`InfraDefinition.source_uri` is set by **the backend** (`api-apps/upload.rs:23-69`):
the frontend POSTs `/workspaces/:wsId/apps/:appId/infra/upload-url`, the backend
returns a presigned `PUT` into `state.specs_bucket` (the backend's S3 bucket),
the frontend uploads there, and `source_uri` = `s3://<backend-specs-bucket>/uploads/...`.

**Problem:** the customer agent's CodeBuild role only has read access to its
own `artifactsBucket` (in the customer's account). It cannot read from the
backend's specs bucket without cross-account S3 grants on both sides.

The agent already has `POST /v1/commands/get-upload-url` (`get-upload-url.ts`),
which returns a presigned `PUT` URL into the agent's `artifactsBucket`. **This
route exists but isn't currently called by anyone** — strong hint it was
designed for exactly this case but never wired.

Three architectural options, in order of "how much customer code stays in the
customer account":

### (a) Frontend uploads via the agent (most isolation, more hops)

1. Frontend asks backend "I want to upload infra for app X" → backend calls the agent's `get-upload-url` (over the IAM-signed channel) and proxies the presigned URL back.
2. Frontend `PUT`s the zip to that URL — directly into the customer's S3 bucket.
3. Backend stores `source_uri = s3://<customer-artifacts-bucket>/uploads/...` on the InfraDefinition.
4. Synth dispatches with that URI. Agent's CodeBuild role already has the IAM grant.

**Trade-off:** customer source code never lands in the lonic backend account at all. Two extra hops on upload (backend → agent for URL; frontend → agent for PUT). The agent's `get-upload-url` is now load-bearing.

### (b) Backend uploads, then copies to agent on dispatch (current upload flow + S3 copy)

Keep current frontend → backend upload as-is. On synth dispatch, backend does an `s3 cp` (or `s3 sync`) from the backend specs bucket to the agent's artifacts bucket via the agent's `get-upload-url` flow, then dispatches with the customer-side URI.

**Trade-off:** less frontend churn. Customer source briefly transits through the lonic backend account. Storage doubled (until cleanup).

### (c) Cross-account S3 ACL on the backend bucket

Add a bucket policy on the backend's specs bucket allowing each customer's agent CodeBuild role to read its own `uploads/<orgId>/...` prefix. Agent CodeBuild reads directly from the backend bucket.

**Trade-off:** no upload flow changes. Bucket policy grows unbounded with customers — manageable via a regex on the role ARN pattern. Customer source permanently lives in the lonic backend account, which is the worst posture for "code never leaves customer account."

**Decision: (a).** Customer code never enters the lonic backend account; the
agent's existing `get-upload-url` graduates from "orphan" to "wired"; IAM
scoping stays clean.

**Implementation outline:**
- Backend rewires `POST /workspaces/:wsId/apps/:appId/infra/upload-url` (`api-apps/upload.rs`) to:
  1. Look up the workspace's agent → fetch `agent.apiUrl`.
  2. SigV4-POST to `<apiUrl>/v1/commands/get-upload-url` (the existing agent endpoint).
  3. Return the agent-issued presigned URL to the caller.
- `InfraDefinition.source_uri` now points to `s3://<customer-artifacts-bucket>/...`.
- Synth dispatch reads that URI and includes it in `payload.sourceUri`. CodeBuild's existing IAM grant on `artifactsBucket` covers the read.

**Action items:**
- [ ] Implement the proxy on the backend (one new function in `api-apps/upload.rs`).
- [ ] Verify the agent's `get-upload-url` endpoint accepts the same SigV4-from-backend-role flow as the other commands.
- [ ] Move `get-upload-url` from the orphan list to "wired" once the backend is calling it.

---

## Recently fixed (for context)

| Issue | Resolution |
|---|---|
| Custom resource failed: `Backend did not return a callbackToken` | Agent registration handler now unwraps the backend's `{ data: ... }` envelope. (commit `587cd26`) |
| `apiUrl` / `apiArn` never persisted on the agent record → backend dispatch always returned `NotFound` | Agent now sends `apiUrl` / `apiArn` at registration; backend persists them on the agent record. (agent-infra `a7c1965`, lonic-cloud-api `822f641`) |
| Many `StateOutput` misuses producing invalid JSONata at synth time | Migrated to `ExecutionInput` / `Literal` / `JsonataExpr` in lonic-cdk-commons 0.1.29. |

---

## Open questions

- [x] **Source archive location** — **decided (a)**: backend proxies the agent's `get-upload-url`. Implementation outlined in the Source archive location section above.
- [ ] **Orchestrator output piping** — Pass state vs `deploy-pipeline` reuse. Decision blocks the synth → deploy chain even after sourceUri is fixed.
- [ ] **`provision` design** — new agent state machine, or reuse `deploy-pipeline` / split into `synth-infrastructure` + `deploy-stacks` on the backend?
- [ ] **Orphan policy** — delete unused routes aggressively, or keep as forward-compat scaffolding? (Lean toward deleting — they can come back via PR when the matching backend caller lands.) Note: if we go with source-archive option (a), `get-upload-url` graduates out of the orphan list.
- [ ] **Heartbeat interval** — default is 30 minutes (`RuntimeErrorReporter.reportingInterval`). Is that the right cadence for "is this agent alive" detection, or should it be tighter (5–10 min)?
- [ ] **Payload-contract audit** — verify each entry in the "Other dispatches with unverified payload contracts" subsection by reading the matching state-machine input.
