# Agent Communication Protocol

This document describes every API endpoint on the agent and every callback the agent makes to the backend. The agent is deployed as a CloudFormation stack in the customer's AWS account.

## Agent Stack Overview

**Stack Name:** `LonicCloudAgentStack`
**API Name:** `LonicCloudAgentApi` (REST API, stage `v1`)

### Stack Parameters (set by backend at deploy/update time)

| Parameter | Description |
|-----------|------------|
| `AgentId` | Unique identifier assigned by the backend |
| `SetupToken` | Single-use token for initial registration |

### Stack Props (baked into the template at synth time)

| Prop | Description |
|------|------------|
| `backendRoleArn` | IAM role ARN allowed to invoke the agent API |
| `artifactBucket` | S3 bucket for Lambda code artifacts |
| `agentVersion` | Semantic version of the agent |
| `callbackBaseUrl` | Backend base URL for callbacks (e.g., `https://api.lonic.dev`) |

### Stack Outputs (SSM Parameters)

| Output | Value |
|--------|-------|
| `ApiUrl` | Agent REST API base URL |
| `ApiArn` | Agent REST API ARN (for IAM policy scoping) |
| `CallbackTokenSecretArn` | Secrets Manager ARN containing the bearer token |

## Security

- **Inbound (backend → agent):** All agent API endpoints require **IAM authentication** (`execute-api:Invoke`). The API has a resource policy that only allows the `backendRoleArn` to invoke it. No public access.
- **Outbound (agent → backend):** All callbacks use **Bearer token** in the `Authorization` header. The token is stored in Secrets Manager and was issued during registration.

---

## Part 1: Backend → Agent (Agent API Endpoints)

All routes are under the agent's API Gateway base URL.

### 1.1 Health Check

```
GET /health
Auth: IAM
Type: Lambda (sync)
```

**Response (200):**
```json
{
  "status": "healthy",
  "agentId": "<agent_id>",
  "agentVersion": "0.1.0",
  "accountId": "123456789012",
  "region": "eu-west-1"
}
```

The health check Lambda calls `sts:GetCallerIdentity` to verify AWS credentials are functional.

---

### 1.2 Error Stats

```
GET /error-stats
Auth: IAM
Type: Lambda (sync)
```

**Response (200):**
```json
{
  "healthy": true,
  "totalErrors": 0,
  "functions": {
    "EventReporter": {
      "functionName": "LonicCloudAgent-EventReporter-abc123",
      "errors": { "1h": 0, "24h": 0 }
    },
    "HealthCheck": {
      "functionName": "LonicCloudAgent-HealthCheck-def456",
      "errors": { "1h": 0, "24h": 0 }
    },
    "GetUploadUrl": {
      "functionName": "LonicCloudAgent-GetUploadUrl-ghi789",
      "errors": { "1h": 0, "24h": 0 }
    },
    "CommandQueueConsumer": {
      "functionName": "LonicCloudAgent-CommandQueue-jkl012",
      "errors": { "1h": 0, "24h": 0 }
    }
  },
  "queriedAt": "2024-01-15T12:35:00.000Z"
}
```

Queries CloudWatch `GetMetricStatistics` for Lambda `Errors` metric over 1h and 24h windows.

---

### 1.3 Get Upload URL

```
POST /commands/get-upload-url
Auth: IAM
Type: Lambda (sync)
```

**Request:**
```json
{
  "filename": "source.zip"
}
```

**Response (200):**
```json
{
  "uploadUrl": "https://s3.amazonaws.com/bucket/uploads/550e8400-e29b-41d4-a716-446655440000/source.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&...",
  "sourceUri": "s3://bucket/uploads/550e8400-e29b-41d4-a716-446655440000/source.zip",
  "expiresInSeconds": 900
}
```

**Backend usage flow:**
1. Call `POST /commands/get-upload-url` with the filename
2. Upload the CDK source archive to the returned `uploadUrl` via HTTP PUT
3. Use the returned `sourceUri` in subsequent synth/pipeline commands

The upload URL is a presigned S3 PUT URL. The key is scoped to `uploads/<uuid>/<filename>` to prevent collisions. Expires in 15 minutes.

---

### 1.4 Synchronous Commands

These commands use Express (synchronous) Step Functions workflows. The response contains the full execution result.

#### 1.4.1 Describe Stacks

```
POST /commands/describe-stacks
Auth: IAM
Type: Express (sync)
Timeout: 5 minutes
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "stackNames": ["MyAppStack", "MyDatabaseStack"]
  }
}
```

**Response (200):**
The raw Step Functions execution output — an array of CloudFormation `DescribeStacks` results per stack.

**On error:**
```json
{
  "error": "States.TaskFailed",
  "cause": "Stack not found: MyAppStack"
}
```

---

#### 1.4.2 Get Execution Status

```
POST /commands/get-execution-status
Auth: IAM
Type: Express (sync)
Timeout: 1 minute
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "executionArn": "arn:aws:states:eu-west-1:123456789012:execution:LonicAgent-DeployStacks:exec-123"
  }
}
```

**Response (200):**
```json
{
  "executionArn": "arn:aws:states:...",
  "status": "SUCCEEDED",
  "output": { "...": "..." }
}
```

Or if failed:
```json
{
  "executionArn": "arn:aws:states:...",
  "status": "FAILED",
  "error": "DEPLOY_FAILED",
  "cause": "Stack deployment failed"
}
```

---

#### 1.4.3 Start Execution (Generic)

```
POST /commands/start-execution
Auth: IAM
Type: Express (sync)
Timeout: 1 minute
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "stateMachineArn": "arn:aws:states:eu-west-1:123456789012:stateMachine:LonicAgent-DeployStacks",
    "input": {
      "commandId": "cmd-inner",
      "callbackUrl": "https://...",
      "payload": { "...": "..." }
    }
  }
}
```

**Response (200):**
```json
{
  "executionArn": "arn:aws:states:eu-west-1:123456789012:execution:LonicAgent-DeployStacks:exec-456",
  "startDate": "2024-01-15T12:00:00.000Z"
}
```

Thin wrapper around SFN `StartExecution`. Useful for starting state machines dynamically.

---

### 1.5 Asynchronous Commands (via SQS Queue)

All async commands go through a shared SQS queue:

```
API Gateway → SQS SendMessage → Consumer Lambda → SFN StartExecution
```

**Response for ALL async commands (202 Accepted):**
```json
{
  "status": "accepted",
  "messageId": "a1b2c3d4-5678-90ab-cdef-EXAMPLE11111"
}
```

**Error response (500):**
```json
{
  "error": "Failed to enqueue command"
}
```

The actual execution result is delivered via **callback** (see Part 2). The `messageId` is the SQS message ID — useful for tracing but not needed for normal operation.

**Queue details:**
- Visibility timeout: 60 seconds
- Dead-letter queue: 3 retries, 14-day retention
- Consumer Lambda: batch size 1
- DLQ alarm triggers runtime error reporting to backend

---

#### 1.5.1 Deploy Stacks

```
POST /commands/deploy-stacks
Auth: IAM
Type: Async (SQS → Standard SFN)
Timeout: 60 minutes
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "stackNames": ["NetworkStack", "AppStack", "MonitoringStack"],
    "templateBaseUrl": "https://s3.eu-west-1.amazonaws.com/bucket/artifacts/synth-output"
  }
}
```

**Processing:**
For each stack (max concurrency 5):
1. Check if stack exists via `DescribeStacks`
2. Create change set (type `CREATE` for new stacks, `UPDATE` for existing)
3. Template URL: `{templateBaseUrl}/{stackName}.template.json`
4. Poll until change set status is `CREATE_COMPLETE`
5. Execute the change set
6. Poll until stack status is `CREATE_COMPLETE` or `UPDATE_COMPLETE`

**Capabilities:** `CAPABILITY_NAMED_IAM`, `CAPABILITY_IAM`, `CAPABILITY_AUTO_EXPAND`

**Callback output (on success):** Per-stack deployment results.

**Callback output (on failure):**
```json
{
  "error": "DEPLOY_FAILED",
  "cause": "Stack deployment failed"
}
```

---

#### 1.5.2 Destroy Stacks

```
POST /commands/destroy-stacks
Auth: IAM
Type: Async (SQS → Standard SFN)
Timeout: 30 minutes
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "stackNames": ["MonitoringStack", "AppStack", "NetworkStack"]
  }
}
```

**Important:** Stacks are deleted **sequentially** (concurrency 1). The caller must provide stack names in dependency-safe order (children first, parents last).

**Processing per stack:**
1. Call `DeleteStack`
2. Poll until `DELETE_COMPLETE` or `DOES_NOT_EXIST`
3. Fail if `DELETE_FAILED`

---

#### 1.5.3 Detect Drift

```
POST /commands/detect-drift
Auth: IAM
Type: Async (SQS → Standard SFN)
Timeout: 10 minutes
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "stackName": "MyAppStack"
  }
}
```

**Processing:**
1. Call `DetectStackDrift`
2. Poll `DescribeStackDriftDetectionStatus` until `DETECTION_COMPLETE`
3. Call `DescribeStackResourceDrifts` (filters: `MODIFIED`, `DELETED`, `NOT_CHECKED`)
4. Return drift details in callback

---

#### 1.5.4 Get Changeset (Preview)

```
POST /commands/get-changeset
Auth: IAM
Type: Async (SQS → Standard SFN)
Timeout: 10 minutes
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "stackName": "MyAppStack",
    "templateUrl": "https://s3.amazonaws.com/bucket/template.json",
    "changeSetType": "UPDATE"
  }
}
```

**Processing:**
1. Create change set with the specified type (`CREATE` or `UPDATE`)
2. Poll until `CREATE_COMPLETE`
3. Return change set details (list of changes) in callback
4. Delete the change set (cleanup — this is a preview, not an apply)

---

#### 1.5.5 Self-Update

```
POST /commands/self-update
Auth: IAM
Type: Async (SQS → Standard SFN)
Timeout: 30 minutes
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "stackName": "LonicCloudAgent",
    "templateUrl": "https://s3.amazonaws.com/bucket/agent-templates/v0.2.0/template.json"
  }
}
```

**Processing:**
1. Create change set (always type `UPDATE` — agent stack must exist)
2. Poll until change set is `CREATE_COMPLETE`
3. Execute the change set
4. Poll until stack is `UPDATE_COMPLETE`

**Note:** This updates the agent's own CloudFormation stack. The backend should synthesize the new agent template beforehand and upload it via the `get-upload-url` flow.

---

#### 1.5.6 Synth Commands (4 variants)

All four share the same request/response structure, differing only in the route path and the intended use:

| Route | State Machine | Use Case |
|-------|--------------|----------|
| `POST /commands/synth-pipeline` | `LonicAgent-SynthPipeline` | Synthesize a pipeline spec CDK app |
| `POST /commands/synth-infrastructure` | `LonicAgent-SynthInfrastructure` | Synthesize an infra spec CDK app |
| `POST /commands/synth-cdk-project` | `LonicAgent-SynthCdkProject` | Synthesize a customer CDK project |
| `POST /commands/discover-stacks` | `LonicAgent-DiscoverStacks` | Synthesize and return stack metadata only |

```
Auth: IAM
Type: Async (SQS → Standard SFN)
Timeout: 30 minutes
```

**Request (all variants):**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "sourceUri": "s3://bucket/uploads/550e8400-e29b-41d4-a716-446655440000/source.zip"
  }
}
```

**Processing:**
1. Download source archive from S3 (`sourceUri`)
2. Run `cdk synth` in CodeBuild (ARM64)
3. Upload synthesized artifacts to S3
4. Return artifact URI, stack names, and deployment waves in callback

**Callback output (on success):**
```json
{
  "ArtifactUri": "s3://bucket/artifacts/build-123/output.zip",
  "Stacks": ["NetworkStack", "AppStack", "MonitoringStack"],
  "DeploymentWaves": [
    { "stacks": ["NetworkStack"], "dependencies": [] },
    { "stacks": ["AppStack", "MonitoringStack"], "dependencies": ["NetworkStack"] }
  ]
}
```

---

#### 1.5.7 Deploy Pipeline (Synth + Deploy)

```
POST /commands/deploy-pipeline
Auth: IAM
Type: Async (SQS → Standard SFN)
Timeout: 60 minutes
```

**Request:**
```json
{
  "commandId": "cmd-abc123",
  "callbackUrl": "https://api.lonic.dev/agent/callback",
  "payload": {
    "sourceUri": "s3://bucket/uploads/550e8400-e29b-41d4-a716-446655440000/source.zip"
  }
}
```

**Processing (two-phase pipeline):**
1. **Synth phase:** Run `cdk synth` in CodeBuild on the source archive
2. **Deploy phase:** Deploy all discovered stacks in dependency order
   - Sequential waves (respecting dependencies)
   - Parallel within each wave
   - Uses CloudFormation change sets (`CREATE` or `UPDATE`)

This is the full end-to-end pipeline: source → synthesize → deploy. It combines synth and deploy-stacks into a single atomic operation.

---

## Part 2: Agent → Backend (Callbacks)

### 2.1 Registration

**When:** Agent CloudFormation stack is created or updated (custom resource).

```
POST <callbackBaseUrl>/agent/register
Content-Type: application/json

{
  "agentId": "agent_abc123",
  "setupToken": "tok_xyz789",
  "agentVersion": "0.1.0"
}
```

**Expected response (200):**
```json
{
  "callbackToken": "cb_token_secure_random_string"
}
```

The agent stores the `callbackToken` in Secrets Manager for all subsequent callbacks.

---

### 2.2 Deregistration

**When:** Agent CloudFormation stack is deleted (custom resource cleanup).

```
POST <callbackBaseUrl>/agent/deregister
Content-Type: application/json

{
  "agentId": "agent_abc123"
}
```

**Expected response (200):**
```json
{
  "status": "deregistered"
}
```

Non-fatal if this fails (stack deletion continues regardless).

---

### 2.3 Command Completion Callback

**When:** Any Step Functions execution completes (SUCCEEDED, FAILED, TIMED_OUT, or ABORTED). Triggered by EventBridge → event-reporter Lambda.

```
POST <callbackUrl from original command input>
Authorization: Bearer <callbackToken>
Content-Type: application/json

{
  "agentId": "agent_abc123",
  "commandId": "cmd-abc123",
  "executionArn": "arn:aws:states:eu-west-1:123456789012:execution:LonicAgent-DeployStacks:exec-123",
  "status": "SUCCEEDED",
  "output": {
    "...": "command-specific output"
  },
  "startDate": "2024-01-15T12:00:00.000Z",
  "stopDate": "2024-01-15T12:05:30.000Z"
}
```

Or on failure:
```json
{
  "agentId": "agent_abc123",
  "commandId": "cmd-abc123",
  "executionArn": "arn:aws:states:...",
  "status": "FAILED",
  "error": "DEPLOY_FAILED",
  "cause": "Stack deployment failed",
  "startDate": "2024-01-15T12:00:00.000Z",
  "stopDate": "2024-01-15T12:03:15.000Z"
}
```

**Possible status values:** `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `ABORTED`

The event-reporter Lambda also enriches the callback with:
- `cloudformation:DescribeStackEvents` data (for deployment commands)
- `codebuild:BatchGetBuilds` data (for synth commands — includes build logs)

---

### 2.4 Runtime Error Alert

**When:** A CloudWatch alarm fires for a monitored Lambda's `Errors` metric. Triggered by SNS → alarm reporter Lambda.

```
POST <callbackBaseUrl>/agent/runtime-error
Authorization: Bearer <callbackToken>
Content-Type: application/json

{
  "agentId": "agent_abc123",
  "type": "runtime-error",
  "alarm": {
    "name": "LonicAgent-EventReporter-ErrorAlarm",
    "description": "Errors >= 1 for 5 minutes",
    "newState": "ALARM",
    "reason": "Threshold Crossed: 3 datapoints were greater than or equal to the threshold (1.0).",
    "timestamp": "2024-01-15T12:10:00.000Z"
  }
}
```

Also sent when the alarm resolves:
```json
{
  "agentId": "agent_abc123",
  "type": "runtime-error",
  "alarm": {
    "name": "LonicAgent-EventReporter-ErrorAlarm",
    "newState": "OK",
    "reason": "Threshold Crossed: 1 datapoint was not greater than or equal to the threshold (1.0).",
    "timestamp": "2024-01-15T12:20:00.000Z"
  }
}
```

**Monitored functions:** event-reporter, health-check, get-upload-url, command-queue consumer.

---

### 2.5 Scheduled Error Stats Push

**When:** Every 30 minutes (EventBridge scheduled rule). **Only sent when errors exist** (won't push if all healthy).

```
POST <callbackBaseUrl>/agent/error-stats
Authorization: Bearer <callbackToken>
Content-Type: application/json

{
  "agentId": "agent_abc123",
  "healthy": false,
  "totalErrors": 5,
  "functions": {
    "EventReporter": {
      "functionName": "LonicCloudAgent-EventReporter-abc123",
      "errors": { "1h": 3, "24h": 8 }
    },
    "HealthCheck": {
      "functionName": "LonicCloudAgent-HealthCheck-def456",
      "errors": { "1h": 2, "24h": 5 }
    },
    "GetUploadUrl": {
      "functionName": "LonicCloudAgent-GetUploadUrl-ghi789",
      "errors": { "1h": 0, "24h": 0 }
    },
    "CommandQueueConsumer": {
      "functionName": "LonicCloudAgent-CommandQueue-jkl012",
      "errors": { "1h": 0, "24h": 0 }
    }
  },
  "queriedAt": "2024-01-15T12:30:00.000Z"
}
```

---

## Part 3: Typical Flows

### 3.1 Full Deployment Flow (Backend Orchestration)

```
Backend                          Agent
  │                                │
  │  1. POST /commands/get-upload-url
  │     { filename: "source.zip" } │
  │───────────────────────────────►│
  │◄───────────────────────────────│
  │  { uploadUrl, sourceUri }      │
  │                                │
  │  2. PUT <uploadUrl>            │
  │     (upload source.zip to S3)  │
  │───────────────────────────────►│ (S3 direct)
  │                                │
  │  3. POST /commands/synth-infrastructure
  │     { sourceUri }              │
  │───────────────────────────────►│
  │◄─ 202 { status: "accepted" }──│
  │                                │
  │     ... CodeBuild runs ...     │
  │                                │
  │  4. Callback: synth succeeded  │
  │     { ArtifactUri, Stacks,     │
  │       DeploymentWaves }        │
  │◄───────────────────────────────│
  │                                │
  │  5. POST /commands/deploy-stacks
  │     { stackNames,              │
  │       templateBaseUrl }        │
  │───────────────────────────────►│
  │◄─ 202 { status: "accepted" }──│
  │                                │
  │     ... CloudFormation ...     │
  │                                │
  │  6. Callback: deploy succeeded │
  │◄───────────────────────────────│
```

### 3.2 Agent Self-Update Flow

```
Backend                          Agent
  │                                │
  │  1. Synthesize new agent       │
  │     template (backend-side)    │
  │                                │
  │  2. POST /commands/get-upload-url
  │     { filename: "template.json" }
  │───────────────────────────────►│
  │◄─ { uploadUrl, sourceUri } ───│
  │                                │
  │  3. PUT <uploadUrl>            │
  │     (upload template.json)     │
  │───────────────────────────────►│ (S3 direct)
  │                                │
  │  4. POST /commands/self-update │
  │     { stackName, templateUrl } │
  │───────────────────────────────►│
  │◄─ 202 { status: "accepted" }──│
  │                                │
  │     ... CloudFormation update  │
  │     ... agent updates itself   │
  │                                │
  │  5. Callback: update succeeded │
  │◄───────────────────────────────│
  │                                │
  │  6. Re-registration (auto)     │
  │◄───────────────────────────────│
```

### 3.3 Git-Triggered Deployment Flow

```
Git Provider      Customer AWS        Agent            Backend
    │              (EventBridge)         │                │
    │  1. Push     │                    │                │
    │─────────────►│                    │                │
    │              │  2. CodeStar       │                │
    │              │     Connection     │                │
    │              │     event          │                │
    │              │───────────────────►│                │
    │              │                    │                │
    │              │                    │  3. POST       │
    │              │                    │  /agent/callback
    │              │                    │  { repo, branch,│
    │              │                    │    commitSha }  │
    │              │                    │───────────────►│
    │              │                    │                │
    │              │                    │  4. Backend    │
    │              │                    │  decides what  │
    │              │                    │  to deploy     │
    │              │                    │                │
    │              │                    │  5. Backend    │
    │              │                    │  dispatches    │
    │              │                    │  commands      │
    │              │                    │◄───────────────│
```

---

## Part 4: Agent State Machine Names

All agent state machines follow the naming convention `LonicAgent-<Name>`:

| State Machine | Type | Route |
|---------------|------|-------|
| `LonicAgent-DeployStacks` | STANDARD | `/commands/deploy-stacks` |
| `LonicAgent-DestroyStacks` | STANDARD | `/commands/destroy-stacks` |
| `LonicAgent-DetectDrift` | STANDARD | `/commands/detect-drift` |
| `LonicAgent-GetChangeset` | STANDARD | `/commands/get-changeset` |
| `LonicAgent-SelfUpdate` | STANDARD | `/commands/self-update` |
| `LonicAgent-SynthPipeline` | STANDARD | `/commands/synth-pipeline` |
| `LonicAgent-SynthInfrastructure` | STANDARD | `/commands/synth-infrastructure` |
| `LonicAgent-SynthCdkProject` | STANDARD | `/commands/synth-cdk-project` |
| `LonicAgent-DiscoverStacks` | STANDARD | `/commands/discover-stacks` |
| `LonicAgent-DeploymentPipeline` | STANDARD | `/commands/deploy-pipeline` |
| `LonicAgent-DescribeStacks` | EXPRESS | `/commands/describe-stacks` |
| `LonicAgent-GetExecutionStatus` | EXPRESS | `/commands/get-execution-status` |
| `LonicAgent-StartExecution` | EXPRESS | `/commands/start-execution` |
