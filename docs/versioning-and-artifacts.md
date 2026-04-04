# Versioning and Artifact Distribution

How the agent is built, versioned, published, deployed, and updated.

---

## Overview

The agent is distributed as a CloudFormation template with Lambda binaries stored in a public S3 bucket. A single version number ties the template and its Lambda artifacts together. Customers deploy the agent from a customized template downloaded from the lonic dashboard — they never run CDK themselves.

```
Build pipeline (lonic account)          lonic dashboard                  Customer account
┌────────────────────────────┐        ┌───────────────────────┐        ┌──────────────────────────┐
│ 1. cargo lambda build      │        │                       │        │                          │
│ 2. Upload zips to S3       │        │ Customer clicks       │        │  CloudFormation stack    │
│ 3. cdk synth (bake globals)│        │ "Deploy agent"        │        │  (from customized        │
│ 4. Upload template to S3   │        │                       │        │   template)              │
│                            │        │ Backend injects       │        │                          │
│ Published once per version │        │ AgentId + SetupToken  │───────>│  CR Lambda registers     │
│                            │        │ into the template     │        │  with backend, gets      │
└────────────────────────────┘        └───────────────────────┘        │  bearer token            │
                                                                       └──────────────────────────┘
```

---

## Version source of truth

The version comes from `lambdas/Cargo.toml` (the workspace root). The Rust binary embeds it at compile time via `env!("CARGO_PKG_VERSION")`. The CDK synth process reads the same version to construct S3 artifact paths.

Versioning follows semver. A release is a single atomic artifact: the template and all Lambda zips at the same version.

---

## Artifact layout

```
s3://{artifact-bucket}/
└── agent/
    └── v{version}/
        ├── template.json                  # CloudFormation template
        ├── event-reporter-arm64.zip       # Lambda binary
        └── health-check-arm64.zip         # Lambda binary
```

All Lambda zips target `aarch64-unknown-linux-gnu` (ARM64) for the `provided.al2023` runtime.

---

## Two categories of configuration

### Baked at synth time (global, same for all customers)

These are provided to `cdk synth` as CDK context variables by the build pipeline:

```
npx cdk synth \
  -c backendRoleArn=arn:aws:iam::LONIC_ACCOUNT:role/LonicBackendRole \
  -c artifactBucket=lonic-agent-artifacts \
  -c agentVersion=0.3.0 \
  -c callbackBaseUrl=https://api.lonic.dev
```

| Context variable   | Description                                                           | Example                                             |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| `backendRoleArn`   | ARN of the lonic backend's IAM role (cross-account API Gateway access)| `arn:aws:iam::123456789012:role/LonicBackendRole`   |
| `artifactBucket`   | Name of the public S3 bucket hosting agent artifacts                  | `lonic-agent-artifacts`                              |
| `agentVersion`     | The version being released                                            | `0.3.0`                                              |
| `callbackBaseUrl`  | Base URL of the lonic hosted backend                                  | `https://api.lonic.dev`                              |

The stack constructs Lambda S3 keys from these:

```
s3://{artifactBucket}/agent/v{agentVersion}/event-reporter-arm64.zip
```

### Injected per customer (replaced in the template at download time)

These are CloudFormation parameters with placeholder defaults. When a customer clicks "Deploy agent" on the lonic dashboard, the backend replaces the placeholders before serving the template:

| CfnParameter  | Placeholder        | Description                                          |
| ------------- | ------------------ | ---------------------------------------------------- |
| `AgentId`     | `{{AGENT_ID}}`     | UUID identifying this agent instance                 |
| `SetupToken`  | `{{SETUP_TOKEN}}`  | Single-use, short-lived token for initial registration |

Both parameters use `NoEcho: true` to prevent values from appearing in the CloudFormation console.

---

## Agent registration flow

The agent must prove it has a valid, paid license before it can communicate with the backend. This is enforced via a setup token exchange during the initial CloudFormation deployment.

### How it works

1. **Customer clicks "Deploy agent"** on the lonic dashboard.
2. **Backend generates** a UUID `agentId` and a short-lived, single-use `setupToken`. Both are stored in the backend database.
3. **Backend fetches** the published template from `s3://{artifact-bucket}/agent/v{latest}/template.json`.
4. **Backend replaces** `{{AGENT_ID}}` and `{{SETUP_TOKEN}}` placeholders with the generated values.
5. **Customer deploys** the customized template (via CloudFormation console, CLI, or a quick-create link).
6. **During stack creation**, a CloudFormation Custom Resource Lambda fires:
   - Calls `POST {callbackBaseUrl}/agent/register` with `{ agentId, setupToken, agentVersion }`.
   - Backend validates the setup token (exists, not expired, not already used), confirms the customer's license.
   - Backend returns a long-lived `callbackToken` (bearer token).
   - The Custom Resource stores the token in the stack's Secrets Manager secret.
   - The setup token is consumed — it cannot be reused.
7. **If registration fails** (invalid token, expired, no license), the Custom Resource throws, CloudFormation rolls back the entire stack. The customer sees a clear error.
8. **On stack deletion**, the Custom Resource calls `POST {callbackBaseUrl}/agent/deregister` (best-effort, non-blocking).

### Security properties

- The **long-lived bearer token** never appears in CloudFormation parameters, events, or CloudTrail. It exists only in Secrets Manager.
- The **setup token** appears in the template's parameter defaults, but it's single-use and short-lived. `NoEcho: true` hides it in the CloudFormation console.
- **Anyone can deploy the template** with placeholder values, but the stack creation will fail at the registration step — the placeholders are not valid tokens.
- The backend has **full control** over token issuance — it can revoke tokens, enforce license tiers, rate-limit registrations, etc.

---

## Self-update flow

The hosted backend triggers self-update by sending a command to the agent:

1. Backend sends `update-agent` command with `{ targetVersion: "0.4.0" }`.
2. The agent's update state machine calls `CloudFormation:UpdateStack` with:
   - `TemplateURL`: `https://{artifact-bucket}.s3.amazonaws.com/agent/v0.4.0/template.json`
   - `Parameters`: `AgentId` and `SetupToken` use `UsePreviousValue: true` (the values from the initial deploy are preserved).
3. The Custom Resource receives an `Update` event. It calls `/agent/register` again with the existing agent ID and setup token. The backend should recognize updates from already-registered agents and return the same (or a rotated) bearer token.
4. CloudFormation performs a rolling update. Lambda functions pick up the new code from the new S3 keys baked into the template.
5. The agent reports the update result back to the backend via the callback.

The update is atomic from CloudFormation's perspective. If it fails, CloudFormation rolls back to the previous template and Lambda code.

---

## Build pipeline steps

The pipeline runs on every tagged release (e.g., `v0.3.0` tag on `main`):

1. **Build Rust** — `cargo lambda build --release --arm64` in `lambdas/`
2. **Package zips** — each binary in `target/lambda/{crate}/bootstrap` is zipped
3. **Upload zips** — to `s3://{artifact-bucket}/agent/v{version}/`
4. **Synth template** — `cd cdk && npx cdk synth -c backendRoleArn={role-arn} -c artifactBucket={bucket} -c agentVersion={version} -c callbackBaseUrl={url}`
5. **Upload template** — `template.json` from `cdk.out/` to the same S3 prefix
6. **Validation** (optional) — deploy the template to a test account with a valid setup token, run health check, tear down

---

## Implementation status

### CDK stack

- [x] Read `backendRoleArn`, `artifactBucket`, `agentVersion`, `callbackBaseUrl` from CDK context
- [x] `AgentId` and `SetupToken` as CfnParameters with placeholder defaults
- [x] Import the artifact bucket as `s3.Bucket.fromBucketName()`
- [x] Event-reporter Lambda with `Code.fromBucket()`, `Architecture.ARM_64`, `Runtime.PROVIDED_AL2023`
- [x] Secrets Manager secret for callback bearer token
- [x] Registration Custom Resource Lambda (inline Node.js) — exchanges setup token for bearer token
- [x] IAM permissions: secret read/write, Step Functions task tokens, CloudFormation events
- [x] Environment variables: `LONIC_CALLBACK_TOKEN_ARN`, `LONIC_CALLBACK_BASE_URL`, `AGENT_ID`
- [x] Health-check Lambda with `GET /health` API Gateway route

### Context validation

- [x] `bin/cdk.ts` validates all four context variables (fail fast with a clear error)

---

## What external infrastructure must implement

This section describes what the team managing lonic's internal AWS infrastructure needs to provide for the agent distribution to work.

### Public artifact S3 bucket

- **Bucket name:** a well-known name (e.g., `lonic-agent-artifacts`), consistent across environments.
- **Public read access:** the bucket policy must allow unauthenticated `s3:GetObject` on `agent/*`. The customer's CloudFormation and Lambda services need to pull the template and zip files without credentials.
  ```json
  {
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::lonic-agent-artifacts/agent/*"
  }
  ```
- **Versioned paths:** artifacts are stored under `agent/v{version}/`. The pipeline must never overwrite a published version — versions are immutable.
- **HTTPS access:** CloudFormation `TemplateURL` requires HTTPS. The bucket must be accessible via `https://{bucket}.s3.amazonaws.com/...` (default S3 behavior, no extra config needed).
- **Lifecycle / cleanup:** old versions should be retained indefinitely (customers may be running any version). Consider a policy to archive versions older than N months to Glacier.

### Build pipeline

- **Trigger:** git tag matching `v*` on the `main` branch of this repo.
- **Environment:** must support Rust toolchain (stable), `cargo-lambda`, Node.js (for CDK synth), and AWS CLI.
- **Steps:** see [Build pipeline steps](#build-pipeline-steps) above.
- **Idempotency:** the pipeline should fail (not overwrite) if the version already exists in S3. Use `s3api head-object` to check before uploading.
- **Permissions:** the pipeline role needs `s3:PutObject` on the artifact bucket and `s3:HeadObject` for the existence check.

### Backend role for cross-account access

- The backend role ARN is baked into the template by the pipeline (via `-c backendRoleArn=...`). The agent's API Gateway resource policy allows only this role.
- The role itself must also have `execute-api:Invoke` in its own IAM policy (both sides of the cross-account handshake are required).
- The role must be able to sign requests with SigV4 targeting the customer's API Gateway endpoint.

### Agent registration endpoint

The backend must implement the following endpoints:

**`POST /agent/register`**

Request:
```json
{
  "agentId": "uuid",
  "setupToken": "short-lived-token",
  "agentVersion": "0.3.0"
}
```

Validation:
- `setupToken` exists in the database, is not expired, and has not been used.
- The associated customer has a valid, paid license.
- `agentId` matches the one generated alongside the setup token.

Success response (200):
```json
{
  "callbackToken": "long-lived-bearer-token"
}
```

Error responses:
- `401` — invalid or expired setup token.
- `403` — valid token but customer license is inactive.
- `409` — setup token already consumed (idempotent: if the same `agentId` re-registers, return the same token).

On update (already-registered agent re-registering after a stack update): return the existing callback token (or a rotated one). Do not reject the request.

**`POST /agent/deregister`**

Request:
```json
{
  "agentId": "uuid"
}
```

Best-effort cleanup. Mark the agent as deregistered in the backend. Do not fail if the agent is already deregistered or unknown.

### Template customization endpoint

The dashboard needs an endpoint or internal function that:

1. Fetches the published template from S3 for the target version.
2. Generates an `agentId` (UUID) and `setupToken` (cryptographically random, short-lived).
3. Stores both in the backend database, linked to the customer's account.
4. Replaces `{{AGENT_ID}}` and `{{SETUP_TOKEN}}` in the template JSON (these appear as CfnParameter default values).
5. Returns the customized template to the customer (as a download, or as a CloudFormation quick-create URL).

### Version discovery (for the backend)

- The backend needs to know which agent versions exist and what the latest version is, so it can instruct agents to self-update.
- **Option A:** a `latest.json` file at `s3://{artifact-bucket}/agent/latest.json` containing `{ "version": "0.4.0" }`, updated by the pipeline on each release.
- **Option B:** the backend maintains its own version registry, updated by the pipeline via a webhook or API call after a successful publish.
- Either approach works. Option A is simpler; option B gives the backend more control (e.g., staged rollouts, version pinning per customer).
