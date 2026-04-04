# lonic Cloud Agent API — Design

> This document describes the architecture and implementation of the Rust code in `lambdas/`. Originally written as the Phase 1 plan — all steps are now complete.

## Context

This repo contains the code and infrastructure for the lonic cloud agent — a stateless executor deployed into a customer's AWS account. It receives commands from the hosted lonic backend, orchestrates AWS operations via Step Functions (which use native SDK integrations for CloudFormation), and reports status back via HTTPS callbacks.

The Rust cargo workspace contains one Lambda binary and a shared library, covering the MVP command set: deploy-stacks, destroy-stacks, describe-stacks, get-execution-status.

---

## Architecture

```
Hosted Backend (lonic's AWS account)
    │
    ▼ (HTTPS, SigV4 — cross-account IAM auth)
API Gateway (HTTP API v2, IAM authorizationType)
    │                          ← no Lambda authorizer needed
    └── Service Integration ──► Step Functions
                                    │
                                    ├── Native SDK: CloudFormation (describe, delete, changeset)
                                    ├── Native SDK: Start built-in deploy pipeline
                                    │
                                    └── Task state ──► event-reporter Lambda
                                                            │
                                                            ▼ (HTTPS, Bearer token)
                                                       Hosted Backend callback URL
```

### Authentication

- **Inbound (backend → agent):** Cross-account IAM authorization on API Gateway. The customer grants `execute-api:Invoke` to the hosted backend's IAM role. API Gateway validates SigV4 signatures natively — no custom auth code needed.
- **Outbound (agent → backend callbacks):** Bearer token issued by the hosted backend during agent setup. Stored in the customer's Secrets Manager. The agent sends `Authorization: Bearer <token>` on callback requests. This avoids the scaling problem of adding every customer's IAM role to the backend's resource policy.

---

## Repo Structure

```
lonic-cloud-agent-api/
├── Cargo.toml                  # workspace root
├── rust-toolchain.toml         # pin stable toolchain
├── crates/
│   ├── agent-core/             # shared library
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── error.rs        # thiserror-based AgentError
│   │       ├── models/
│   │       │   ├── mod.rs
│   │       │   ├── command.rs  # CommandEnvelope, CommandType
│   │       │   └── status.rs   # StatusUpdate, ExecutionStatus, ErrorDetail
│   │       ├── callback/
│   │       │   ├── mod.rs
│   │       │   └── client.rs   # reqwest client for POSTing status with bearer token
│   │       └── secrets/
│   │           ├── mod.rs
│   │           └── manager.rs  # Secrets Manager client for loading callback token
│   └── event-reporter/         # Lambda binary
│       └── src/
│           └── main.rs         # Receives Step Functions events, POSTs to callback URL
```

---

## Implementation Steps

### Step 1: Workspace skeleton ✅

- Root `Cargo.toml` with workspace members and shared dependencies
- `rust-toolchain.toml` pinning stable
- All crate `Cargo.toml` files
- Empty `lib.rs` / `main.rs` files that compile

**Key workspace dependencies:**
- `serde`, `serde_json` — serialization
- `aws-config`, `aws-sdk-sfn`, `aws-sdk-secretsmanager` — AWS SDK
- `lambda_runtime` — Lambda handler
- `tokio` — async runtime
- `reqwest` (with `rustls-tls`, no OpenSSL needed on Lambda) — HTTP client for callbacks
- `tracing`, `tracing-subscriber` — structured logging
- `thiserror` — typed errors in agent-core
- `chrono` — timestamps

### Step 2: agent-core models ✅

**`error.rs`** — `AgentError` enum with variants: `AuthError`, `InvalidCommand`, `CallbackError`, `AwsError`, `ConfigError`. Uses `thiserror`.

**`models/command.rs`:**
- `CommandEnvelope` — `{ command_id, command_type, payload: Value, callback_url }`
- `CommandType` enum — `DeployStacks`, `DestroyStacks`, `DescribeStacks`, `GetExecutionStatus`
- `payload` stays as `serde_json::Value` for now — the Lambdas don't interpret deploy/destroy payloads (Step Functions handles those natively)

**`models/status.rs`:**
- `StatusUpdate` — `{ command_id, status, step?, outputs?, error?, timestamp }`
- `ExecutionStatus` enum — `Pending`, `InProgress`, `Succeeded`, `Failed`, `TimedOut`
- `ErrorDetail` — `{ message, cfn_events? }`

### Step 3: agent-core secrets ✅

**`secrets/manager.rs`:**
- Load callback bearer token from AWS Secrets Manager at Lambda init time
- Secret ARN from `LONIC_CALLBACK_TOKEN_ARN` env var
- Cache the value — loaded once per cold start
- `SecretLoader::load() -> Result<String, AgentError>`

### Step 4: agent-core callback client ✅

**`callback/client.rs`:**
- `CallbackClient` wraps `reqwest::Client`
- `send_status(callback_url, StatusUpdate)` — serializes, sends with `Authorization: Bearer <token>` header
- 2 retries with exponential backoff for transient HTTP errors

### Step 5: event-reporter Lambda ✅

**`event-reporter/src/main.rs`:**
- Invoked by Step Functions as a Task state (`.waitForTaskToken` pattern)
- Init: load callback token from Secrets Manager, construct `CallbackClient`
- Handler receives: `{ taskToken, commandId, callbackUrl, status, step?, outputs?, error? }`
- Maps to `StatusUpdate`, calls `callback_client.send_status()`
- On success: calls `sfn.send_task_success(task_token)`
- On failure: calls `sfn.send_task_failure(task_token)`

### Step 6: Cleanup ✅

- Remove `authorizer` crate (no longer needed — IAM auth is handled by API Gateway)
- Remove `auth` module from agent-core (no custom HMAC — inbound uses IAM SigV4, outbound uses bearer token)
- Remove HMAC-related dependencies (`hmac`, `sha2`, `hex`, `subtle`)

### Step 7: Test fixtures and CI ✅

- `/tests/events/` — sample JSON event files for `cargo lambda invoke`
- Unit tests throughout agent-core (serde roundtrips, callback client with wiremock)
- Integration tests for event-reporter using JSON fixtures
- GitHub Actions: `fmt --check` → `clippy` → `test` → `cargo lambda build --release`

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API Gateway type | HTTP API v2 | Simpler, cheaper, lower latency. |
| Inbound auth | Cross-account IAM (SigV4) | No custom auth code. Customer grants one IAM role access. API Gateway validates natively. |
| Outbound auth | Bearer token (Secrets Manager) | Scales without modifying backend IAM policies per customer. Token issued during agent setup. |
| `payload` type | `serde_json::Value` | Lambdas don't interpret payloads — Step Functions handles CloudFormation natively. Avoids premature coupling. |
| TLS in reqwest | `rustls-tls` | Pure Rust, no OpenSSL dependency on Lambda `provided.al2023` runtime. |
| Error handling | `thiserror` in lib | Standard Rust pattern. Typed errors in library, ergonomic propagation in binaries. |

---

## Verification

1. `cargo build --workspace` — everything compiles
2. `cargo test --workspace` — all unit tests pass
3. `cargo clippy --workspace -- -D warnings` — no lint warnings
4. `cargo lambda build --release` — produces `target/lambda/event-reporter/bootstrap`
5. `cargo lambda invoke event-reporter --data-file tests/events/task_succeeded.json` — POSTs status (verify with wiremock or local HTTP server)
