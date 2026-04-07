# AI Code Review — Agent-Side Implementation

This document describes what the agent (running in the customer's AWS account) must implement to support AI-powered code reviews on pull requests.

For the backend implementation, see [ai-review-backend.md](ai-review-backend.md).

## Overview

The agent listens for git events (PR opened/updated), packages the repository, sends it to the backend (or processes it locally in BYOK mode), and posts review comments back to the git provider.

**Architecture note:** The managed review pipeline is a single global ECS Fargate cluster shared by all orgs. The agent does not need to provision any review infrastructure — it just calls the backend API. The backend tracks all reviews in DynamoDB and enforces per-org monthly limits.

---

## 1. Git Event Webhook Endpoint

### 1.1 New Agent API Endpoint

```
POST /hooks/git
Auth: HMAC signature (webhook secret) OR IAM (backend-triggered)
Type: Lambda (sync)
```

The agent must accept webhook events from GitHub, GitLab, or Bitbucket. Each git provider sends a different payload format, so the Lambda normalizes the event into a common internal structure.

**Supported events:**
- Pull request opened
- Pull request updated (new commits pushed)
- Pull request reopened

**Normalized event structure (internal):**

```json
{
  "provider": "github" | "gitlab" | "bitbucket",
  "event": "pr_opened" | "pr_updated",
  "repository": {
    "cloneUrl": "https://github.com/org/repo.git",
    "name": "repo"
  },
  "pullRequest": {
    "id": "123",
    "title": "Add user authentication",
    "sourceBranch": "feature/auth",
    "targetBranch": "main",
    "author": "username"
  }
}
```

### 1.2 Webhook Configuration

The agent CloudFormation stack must include:

| Resource | Purpose |
|----------|---------|
| Webhook secret (Secrets Manager) | HMAC validation of incoming webhooks |
| API Gateway route `POST /hooks/git` | Publicly accessible (HMAC-authenticated, not IAM) |

**Note:** Unlike other agent endpoints (IAM-only), the git webhook endpoint must be publicly reachable by git providers. Authentication is via HMAC signature verification (GitHub: `X-Hub-Signature-256`, GitLab: `X-Gitlab-Token`, Bitbucket: `X-Hub-Signature`).

### 1.3 Stack Parameters

New parameters added to the agent stack:

| Parameter | Description |
|-----------|------------|
| `GitProvider` | `github`, `gitlab`, or `bitbucket` |
| `GitToken` | Personal access token or app token (Secrets Manager ARN) — for cloning private repos and posting review comments |
| `AiReviewEnabled` | `true` / `false` — feature toggle |
| `AiReviewMode` | `managed` (send to Lonic backend) or `byok` (process locally) |
| `ClaudeApiKey` | (BYOK only) Anthropic API key (Secrets Manager ARN) |

---

## 2. Repository Packaging

When a git event is received, the agent must package the repository for review.

### 2.1 Packaging Flow

```
1. Clone the repo (or use cached clone if available)
2. git fetch origin targetBranch sourceBranch
3. git checkout targetBranch
4. git archive --format=tar.gz HEAD > repo.tar.gz
5. git diff targetBranch..sourceBranch > changes.patch
6. Package both into a single archive: review-package.tar.gz
     ├── repo.tar.gz       # full repo snapshot at target branch
     ├── changes.patch      # diff between target and source
     └── metadata.json      # branch names, PR info, commit SHAs
```

**Important:** The backend container reconstructs the repo by extracting `repo.tar.gz`, running `git init && git add -A && git commit -m "base"`, then applying `changes.patch` via `git apply`. This leaves the PR changes as uncommitted modifications, so Claude Code sees them via `git diff` — exactly like a developer reviewing locally.

### 2.2 metadata.json

```json
{
  "provider": "github",
  "repository": "org/repo",
  "pullRequest": {
    "id": "123",
    "title": "Add user authentication",
    "sourceBranch": "feature/auth",
    "targetBranch": "main",
    "sourceSha": "abc1234",
    "targetSha": "def5678"
  },
  "packaging": {
    "format": "archive+patch",
    "archiveRef": "def5678",
    "patchRange": "def5678..abc1234"
  }
}
```

The `pullRequest.title` field is used by Claude Code in its review prompt. The `packaging` section is informational and not parsed by the backend.

### 2.3 Upload to S3

Use the existing `POST /commands/get-upload-url` flow:

1. Request upload URL with filename `review-package.tar.gz`
2. Upload the package to S3 via presigned URL
3. Use the returned `sourceUri` in the review request

---

## 3. Request Review from Backend (Managed Mode)

### 3.1 Submit Review

```
POST <callbackBaseUrl>/agent/review
Authorization: Bearer <callback_token>
Content-Type: application/json
```

**Request:**

```json
{
  "agentId": "agent_abc123",
  "reviewId": "rev_001",
  "sourceUri": "s3://bucket/uploads/<uuid>/review-package.tar.gz",
  "metadata": {
    "provider": "github",
    "repository": "org/repo",
    "pullRequest": {
      "id": "123",
      "title": "Add user authentication",
      "sourceBranch": "feature/auth",
      "targetBranch": "main"
    }
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `agentId` | Yes | Must match the authenticated agent identity |
| `reviewId` | No | Client-generated ID for idempotency. If omitted, backend generates `rev_<uuid>` |
| `sourceUri` | Yes | S3 URI to the review package |
| `metadata` | Yes | Git provider info and PR details |

**Response (202 Accepted):**

```json
{
  "data": {
    "reviewId": "rev_001",
    "status": "accepted"
  }
}
```

### 3.2 Error Responses

| Status | Code | When |
|--------|------|------|
| 400 | `BAD_REQUEST` | Invalid request body, missing required fields, or `"monthly review limit reached (50/50)"` |
| 401 | `UNAUTHORIZED` | Invalid or expired bearer token |
| 403 | `FORBIDDEN` | Agent identity mismatch, or org license doesn't include reviews (`maxReviewsPerMonth` is 0) |
| 409 | `CONFLICT` | Concurrent review limit reached (max 3 per org), or duplicate `reviewId` |

**Monthly limit error example:**

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "bad request: monthly review limit reached (50/50)"
  }
}
```

The agent should handle this gracefully — e.g., skip the review and log a warning rather than retrying.

### 3.3 Review Status Polling (Optional)

The agent can poll for review status if it needs to track completion without waiting for the callback:

```
GET <callbackBaseUrl>/reviews/{reviewId}
Authorization: Bearer <callback_token>
```

**Response (200):**

```json
{
  "data": {
    "reviewId": "rev_001",
    "agentId": "agent_abc123",
    "orgId": "org_xyz",
    "wsId": "ws_abc",
    "status": "completed",
    "metadata": {
      "provider": "github",
      "repository": "org/repo",
      "pullRequest": { "..." }
    },
    "result": {
      "summary": "The changes look good...",
      "approval": "approve",
      "comments": [{ "..." }]
    },
    "createdAt": "2026-04-07T10:00:00Z",
    "completedAt": "2026-04-07T10:02:30Z"
  }
}
```

Status values: `pending` → `processing` → `completed` | `failed`

**Note:** Polling is optional. The primary delivery mechanism is the callback (section 5.1). Only poll if the callback fails or for diagnostic purposes.

---

## 4. Local Review (BYOK Mode)

In BYOK mode, the agent runs the review locally without sending source code to Lonic's backend. This is a Phase 3 feature — implement the managed mode first.

### 4.1 BYOK Review Infrastructure

The agent stack includes (when `AiReviewMode=byok`):

| Resource | Purpose |
|----------|---------|
| ECS Cluster (Fargate) | Run review container tasks |
| ECR Repository | Store the review Docker image |
| Task Definition | Claude Code container config |
| VPC (or reuse existing) | Network for Fargate tasks |
| IAM Task Role | S3 access, Secrets Manager access |

### 4.2 BYOK Docker Image

The review Docker image is pre-built and pushed to the agent's ECR repository during agent deployment. Contents:

- Amazon Linux 2023 base
- Node.js 22 (for Claude Code CLI)
- Git
- Claude Code CLI (`@anthropic-ai/claude-code`)
- AWS CLI v2 (for S3 downloads)
- Review orchestration script (`/opt/review/run-review.sh`)

### 4.3 BYOK Flow

```
1. Git event received
2. Package repository (same as section 2)
3. Upload package to local S3 bucket
4. Launch Fargate task with env vars:
     SOURCE_URI=s3://...
     ANTHROPIC_API_KEY=<from Secrets Manager>
     REVIEW_ID=rev_001
     AGENT_ID=agent_abc123
     RESULT_BUCKET=<local-bucket>
     CALLBACK_URL=<local-endpoint>
5. Fargate task:
     a. Download and extract review package
     b. Reconstruct repo with uncommitted changes (git init, git add, git commit, git apply)
     c. Run: claude --print --dangerously-skip-permissions --max-turns 30 "<prompt>"
     d. Upload review result JSON to S3
     e. Notify local callback endpoint
6. Agent reads review result from S3
7. Agent posts comments (section 5.2)
```

### 4.4 Claude Code Invocation (BYOK)

The container runs the same review script as the managed version. See `docker/ai-review/run-review.sh` in the backend repo for the full script. Key flags:

```bash
claude --print \
  --dangerously-skip-permissions \
  --max-turns 30 \
  "<review prompt>"
```

- `--print` — non-interactive, single prompt, exits when done
- `--dangerously-skip-permissions` — no permission prompts (headless container)
- `--max-turns 30` — caps agentic exploration to prevent runaway costs

---

## 5. Processing Review Results

### 5.1 Review Result Callback (Managed Mode)

The backend sends the review result to the agent when the Fargate task completes. This is a best-effort delivery — the result is also persisted in the backend's DynamoDB and can be retrieved via `GET /reviews/{reviewId}`.

```
POST /commands/review-result
Auth: HTTP (no IAM signing — uses plain HTTP POST)
Type: Lambda (sync)
```

**Request:**

```json
{
  "commandId": "review-rev_001",
  "reviewId": "rev_001",
  "result": {
    "summary": "The changes look good overall. The new authentication handler properly validates tokens, but there's an unwrap that could panic on malformed input.",
    "approval": "comment",
    "comments": [
      {
        "file": "src/auth/handler.rs",
        "line": 42,
        "endLine": 45,
        "severity": "warning",
        "body": "This unwrap() will panic if the token is malformed. Use proper error handling instead.",
        "suggestion": "let token = header.parse::<Token>().map_err(|e| ApiError::BadRequest(e.to_string()))?;"
      }
    ]
  }
}
```

**Response (200):**

```json
{
  "status": "received"
}
```

**Important:** The agent must implement this endpoint even if it doesn't exist yet. If the backend can't deliver the result (agent unreachable, endpoint not implemented), the result is still stored in DynamoDB. The agent can fall back to polling `GET /reviews/{reviewId}` to retrieve it.

### 5.2 Review Result JSON Schema

The `result` object follows this schema in all contexts (managed callback, BYOK local, polling):

```json
{
  "summary": "string — brief overview and overall assessment",
  "approval": "approve" | "request_changes" | "comment",
  "comments": [
    {
      "file": "string — relative path from repo root",
      "line": "number — line number in the new/changed file",
      "endLine": "number (optional) — end line for multi-line comments",
      "severity": "suggestion" | "warning" | "issue",
      "body": "string — explanation of the issue or suggestion",
      "suggestion": "string (optional) — replacement code block"
    }
  ]
}
```

### 5.3 Posting Comments to Git Provider

The agent translates the review result into git provider API calls.

#### GitHub

Use the Pull Request Review API to post all comments as a single review:

```
POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
Authorization: Bearer <git_token>

{
  "body": "<summary>",
  "event": "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
  "comments": [
    {
      "path": "<file>",
      "line": <line>,
      "body": "<formatted body>"
    }
  ]
}
```

Map `approval` → `event`: `"approve"` → `"APPROVE"`, `"request_changes"` → `"REQUEST_CHANGES"`, `"comment"` → `"COMMENT"`.

#### GitLab

Post each comment as a separate discussion on the merge request:

```
POST /projects/{id}/merge_requests/{mr_iid}/discussions
Authorization: Bearer <git_token>

{
  "body": "<formatted body>",
  "position": {
    "position_type": "text",
    "new_path": "<file>",
    "new_line": <line>
  }
}
```

Post the summary as a separate note: `POST /projects/{id}/merge_requests/{mr_iid}/notes`.

#### Bitbucket

```
POST /repositories/{workspace}/{repo}/pullrequests/{id}/comments
Authorization: Bearer <git_token>

{
  "content": { "raw": "<formatted body>" },
  "inline": {
    "path": "<file>",
    "to": <line>
  }
}
```

### 5.4 Comment Formatting

Each comment should be formatted as:

```markdown
**AI Review** — <severity>

<body>

```suggestion
<suggestion>
```
```

The `suggestion` block uses GitHub's suggestion syntax so reviewers can apply fixes with one click. GitLab supports the same syntax. For Bitbucket, include the suggestion as a code block since native suggestion syntax is not supported.

If `suggestion` is null/absent, omit the suggestion block entirely.

If the review has no comments (empty array) and `approval` is `"approve"`, post just the summary as a review comment.

---

## 6. Agent Configuration API

The backend configures AI review via existing command patterns:

```
POST /commands/configure-review
Auth: IAM
Type: Lambda (sync)
```

**Request:**

```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "enabled": true,
    "provider": "github",
    "webhookUrl": "https://<agent-api>/hooks/git",
    "repositories": ["org/repo-a", "org/repo-b"],
    "reviewMode": "managed"
  }
}
```

**Response (200):**

```json
{
  "webhookSecret": "<generated_secret>",
  "webhookUrl": "https://<agent-api>/v1/hooks/git"
}
```

The backend or user then configures this webhook URL in their git provider settings.

---

## 7. Implementation Priority

The agent team should implement in this order:

### Phase 1 — Managed Mode (MVP)

1. [x] **PR event subscription** — reuses lonic-cdk-commons webhook infrastructure (singleton API Gateway + receiver Lambda + DynamoDB + HMAC verification + EventBridge emission). No custom webhook endpoint needed.
   - EventBridge rule `AiReviewPrRule` subscribes to `source: lonic.webhook`, `detailType: Pull Request`, `action: opened|updated|reopened`
   - Commons normalized event provides: `provider`, `fullRepositoryId`, `prNumber`, `sourceBranch`, `targetBranch`, `commitId`, `title`, `authorLogin`
2. [x] **Repository packaging** — clone, archive, diff, create `review-package.tar.gz`
   - `lib/review/review-packager.ts` — triggered by EventBridge, clones repo, creates `repo.tar.gz` + `changes.patch` + `metadata.json`, bundles into `review-package.tar.gz`
3. [x] **Upload to S3 + call `POST /agent/review`** — uploads package to the artifacts bucket, submits review request to backend with bearer token auth
   - Implemented within `review-packager.ts` — direct S3 PutObject + HTTPS POST to backend
4. [x] **`POST /commands/review-result` handler** — receive result callback from backend
   - `lib/review/review-result-handler.ts` — on the main IAM-authenticated agent API, receives result JSON, posts comments to git provider
5. [x] **Post comments to GitHub** — plus GitLab and Bitbucket support included from the start
   - GitHub: uses Pull Request Review API (single review with all comments)
   - GitLab: posts summary as note + each comment as a discussion
   - Bitbucket: posts summary + inline comments
   - Comment formatting with severity badges and GitHub-style suggestion blocks
   - Provider is determined from `metadata.provider` in the callback payload (no stack parameter needed)
6. [x] **Error handling** — handles 400 (monthly limit), 403 (forbidden), 409 (concurrent limit) as non-retryable; other errors propagate for Lambda retry
   - Both Lambda functions added to RuntimeErrorReporter monitoring

**Stack parameter added:** `GitToken` (Secrets Manager ARN for git provider access token)
**Architecture:** Commons webhook infra (shared) → EventBridge → review packager Lambda → backend API → review-result callback

### Phase 2 — Polish

7. [x] **GitLab and Bitbucket support** — implemented in Phase 1 (all three providers supported from the start)
8. [x] **Retry logic** — Lambda async invoke already retries twice on failure; non-retryable errors (400/403/409) are caught and skipped
9. [x] **Configuration UI integration** — `POST /commands/configure-review` handler
   - `lib/review/configure-review.ts` — registers/deregisters webhooks on git providers, writes to commons DynamoDB table
   - Uses `WebhookInfrastructure.singleton()` for API Gateway URL and manager Lambda ARN
   - Discovers DynamoDB table name at runtime from manager Lambda env vars (see `docs/commons-task-webhook-table-ref.md`)
   - Enable: creates PR webhooks for listed repos, returns `registrationId` per repo
   - Disable: deletes webhooks by `registrationId`, removes DynamoDB records

### Phase 3 — BYOK

10. [ ] **BYOK infrastructure** — ECS cluster, ECR, task definition in agent stack
11. [ ] **Local review execution** — reuse the same Docker image and script from the managed pipeline
12. [ ] **No data leaves customer account** — customer provides their own Anthropic API key
