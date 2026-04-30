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
| `get-upload-url` | direct Lambda (presigned S3 PUT) | Designed for the manual-upload v1 path that's now deferred to v2. Keep for v2 (master-agent + manual zip). |

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

## Source acquisition — design (git-first)

The primary source-of-truth for customer infra code is **git**, not manual zip
uploads. Lonic's value proposition is automation; making users hand-upload zips
runs counter to that. Manual upload is deferred to a v2 secondary path.

### How sources reach the agent

CodeBuild clones the customer's repo at synth time. **No S3 archive transit
through the lonic backend.** Customer source flows: customer's git host →
agent's CodeBuild → synth output in agent's `artifactsBucket`. Backend never
sees source content, only metadata (repo URL, ref, optional commit SHA).

### Git authentication — universal user-managed Secrets Manager model

We do **not** use AWS CodeConnections. Reasons:
- CodeConnections only solves the clone-from-CodeBuild case. Webhook management,
  PR comments, branch ancestry compare, and other API surfaces lonic uses still
  require a PAT or equivalent.
- CodeConnections doesn't support Azure DevOps, self-hosted Bitbucket Server,
  or niche / self-hosted git servers.

Single auth model across the entire codebase: **PAT in customer-controlled AWS
Secrets Manager**, scoped to a `lonic/*` name prefix.

`GitConnection` schema (backend):
```rust
struct GitConnection {
    provider: String,                  // "github" | "gitlab" | "bitbucket" | "azure-devops" | ...
    api_base_url: Option<String>,      // for self-hosted (GHES, GitLab on-prem, etc.)
    repo_url: String,
    default_branch: String,
    secret_arn: String,                // points at a Secrets Manager secret named lonic/*
    secret_field: Option<String>,      // for JSON-bundled secrets — JSON key to read
}
```

Cost optimisation: a single secret (e.g. `lonic/git-credentials`) holds many
PATs as JSON fields. CodeBuild's native `arn:...:secret:foo:json-key::` syntax
extracts a single field at runtime. One secret per agent → many credentials at
$0.40/month total instead of $0.40 × N.

### Two creation paths for `GitConnection`

Same end state (a record with `secret_arn` + optional `secret_field`); user
chooses based on trust posture.

**Path A — convenience (paste credential, end-to-end encrypted).**

For users who don't want extra setup steps. Token is encrypted client-side
using the agent's public key, so the lonic backend handles only opaque
ciphertext — even a fully compromised backend cannot leak credentials.

1. Agent stack creates a **KMS asymmetric key** (`RSA_2048`, `ENCRYPT_DECRYPT`).
   Public key emitted as a stack output for customer-side verification (auditor
   can compare to what lonic shows in the dashboard).
2. Pubkey sent to backend at registration alongside `apiUrl` / `apiArn`. Backend
   caches on the agent record.
3. Frontend fetches `agent.publicKey` from backend, encrypts the PAT using
   Web Crypto `RSA-OAEP-SHA256`, base64-encodes ciphertext.
4. Frontend → backend → SigV4-POST `/v1/commands/save-git-credential` to the
   agent with `{ key, ciphertext }` (backend relays opaque blob).
5. Agent calls `kms:Decrypt` to get the plaintext, merges field into
   `lonic/git-credentials` secret JSON, returns `{ secretArn, fieldName }`.
6. Backend creates `GitConnection` with the returned ARN/field.

The open-source agent code only ever has a **ciphertext-accepting endpoint**.
There is no plaintext path in commit history. Auditors can verify by reading
the source.

**Path B — max-safety (paste ARN).**

For customers with regulatory / policy constraints requiring credentials never
touch any third-party system, even encrypted.

1. Customer creates the secret directly in their AWS account:
   `aws secretsmanager create-secret --name lonic/git/<id> --secret-string <pat>`
   (or via Console / their own IaC). Secret name **must** start with `lonic/`
   so it falls under the agent's IAM grant.
2. Customer pastes the ARN (and optional JSON field name) into the lonic UI.
3. Backend creates `GitConnection` directly with those values. PAT never enters
   lonic.

### Agent IAM scope

CodeBuild role and credential-management Lambdas all get a single, narrow
grant: `secretsmanager:GetSecretValue` on
`arn:aws:secretsmanager:REGION:ACCOUNT:secret:lonic/*`. Covers both lonic-managed
(Path A) and self-managed (Path B) secrets without being over-broad. The
credential-management Lambdas additionally get `secretsmanager:PutSecretValue`
and `kms:Decrypt` on the agent's KMS key.

### `SourceStep` DYNAMIC mode (commons addition)

Existing `SourceStep` is static (CodeConnections + repo baked in). We add a
`DYNAMIC` mode for runtime-supplied repo + auth:

- Construction: `mode: 'DYNAMIC'`, `artifactBucket`. No `connectionArn`,
  `fullRepositoryId`, `branchName`, `provider`.
- Runtime env (via `environmentVariablesOverride`): `REPO_URL`, `REF`,
  `COMMIT_SHA?`, `APP_DIR?`, `TOKEN_SECRET_ARN?` (full Secrets Manager reference
  including optional JSON-key syntax).
- Buildspec branches on whether `TOKEN_SECRET_ARN` is set: with auth, clones
  via `https://oauth2:$TOKEN@$REPO_URL`; without, clones the public repo plain.
- Outputs unchanged (`ArtifactUri`, `CommitId`, `CommitMessage`).

### Synth wiring

Agent's `synth-infrastructure` state machine becomes
`SourceStep (DYNAMIC) → CdkSynthStep`. `CdkSynthStep` already supports
`DYNAMIC` source via `LONIC_SOURCE_URI`; the chained variable
`SourceStep.ArtifactUri` feeds it.

### Synth dispatch payload

```json
{
  "commandId": "...",
  "callbackUrl": "...",
  "payload": {
    "git": {
      "repoUrl": "https://github.com/customer/repo.git",
      "ref": "main",
      "commitSha": "abc...",                       // optional pin
      "appDirectory": "infra",                      // optional, for monorepos
      "tokenSecretArn": "arn:...:secret:lonic/git-credentials",  // optional, omit for public
      "tokenSecretField": "github-org-foo"          // optional JSON field
    }
  }
}
```

### Decision summary

- **Drop**: master-agent v1, manual zip upload as primary path, CodeConnections.
- **Adopt**: git-first, user-managed Secrets Manager (`lonic/*` prefix), JSON-bundled
  secrets for cost, agent KMS keypair for the convenience path, two creation paths
  for `GitConnection` (encrypted-paste / paste-ARN).
- **Defer to v2**: master-agent model for shared archive distribution if/when
  manual zip upload comes back as a feature.

### Implementation order

1. **commons:** `SourceStep` `DYNAMIC` mode. Publish 0.1.30.
2. **agent:**
   - KMS asymmetric key in CDK; pubkey emitted as stack output and sent at registration.
   - `lonic/git-credentials` secret + IAM grants.
   - `save-git-credential` / `delete-git-credential` / `list-git-credentials` Lambda routes.
   - Chain `SourceStep` (DYNAMIC) → `CdkSynthStep` in `synth-infrastructure`.
3. **backend:**
   - `Agent.publicKey` field, persisted at registration.
   - `GitConnection` schema (`provider`, `api_base_url?`, `repo_url`, `default_branch`, `secret_arn`, `secret_field?`).
   - Two creation flows (relay-ciphertext / store-ARN) on the GitConnection endpoint.
   - `trigger_deployment` builds the synth payload from `GitConnection`.
4. **Frontend (out of scope for this repo):** Web Crypto encryption, dropdown for credential reuse, copy-paste CLI snippets for Path B.

---

## Recently fixed (for context)

| Issue | Resolution |
|---|---|
| Custom resource failed: `Backend did not return a callbackToken` | Agent registration handler now unwraps the backend's `{ data: ... }` envelope. (commit `587cd26`) |
| `apiUrl` / `apiArn` never persisted on the agent record → backend dispatch always returned `NotFound` | Agent now sends `apiUrl` / `apiArn` at registration; backend persists them on the agent record. (agent-infra `a7c1965`, lonic-cloud-api `822f641`) |
| Many `StateOutput` misuses producing invalid JSONata at synth time | Migrated to `ExecutionInput` / `Literal` / `JsonataExpr` in lonic-cdk-commons 0.1.29. |

---

## Open questions

- [x] **Source acquisition** — **decided git-first** with user-managed Secrets Manager auth. Manual zip upload deferred to v2. Implementation outlined in the Source acquisition section above.
- [x] **Frontend trust posture for credentials** — **decided dual-path**: encrypted-paste (Path A, end-to-end via agent KMS keypair) or self-managed ARN (Path B). Both supported.
- [ ] **Orchestrator output piping** — Pass state vs `deploy-pipeline` reuse. Decision blocks the synth → deploy chain even after sourceUri is fixed.
- [ ] **`provision` design** — new agent state machine, or reuse `deploy-pipeline` / split into `synth-infrastructure` + `deploy-stacks` on the backend?
- [ ] **Orphan policy** — delete unused routes aggressively, or keep as forward-compat scaffolding? (Lean toward deleting — they can come back via PR when the matching backend caller lands.) Note: `get-upload-url` stays as deferred-v2 scaffolding for the manual-upload path.
- [ ] **Heartbeat interval** — default is 30 minutes (`RuntimeErrorReporter.reportingInterval`). Is that the right cadence for "is this agent alive" detection, or should it be tighter (5–10 min)?
- [ ] **Payload-contract audit** — verify each entry in the "Other dispatches with unverified payload contracts" subsection by reading the matching state-machine input.
