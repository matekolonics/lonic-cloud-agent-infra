# Deployment Orchestration

The backend is the brain — it decides what to deploy, in what order, to which agent. The agent is a dumb executor that runs individual commands.

## Orchestration Architecture

```
Backend API                Orchestrator (SFN)           Agent Dispatch (SQS)
    │                           │                            │
    │  1. User triggers         │                            │
    │     deployment            │                            │
    │──────────────────────────►│                            │
    │                           │                            │
    │                           │  2. Build deployment plan  │
    │                           │     (resolve deps, order)  │
    │                           │                            │
    │                           │  3. Dispatch: get-upload-url
    │                           │────────────────────────────►│──► Agent
    │                           │◄── callback: { uploadUrl } │
    │                           │                            │
    │                           │  4. Upload source to agent │
    │                           │     (S3 presigned PUT)     │
    │                           │                            │
    │                           │  5. Dispatch: synth        │
    │                           │────────────────────────────►│──► Agent
    │                           │◄── callback: { artifacts } │
    │                           │                            │
    │                           │  6. Check approval gates   │
    │                           │     (pause if needed)      │
    │                           │                            │
    │  User approves            │                            │
    │──────────────────────────►│                            │
    │                           │                            │
    │                           │  7. Dispatch: deploy-stacks│
    │                           │────────────────────────────►│──► Agent
    │                           │◄── callback: { status }    │
    │                           │                            │
    │                           │  8. Update DynamoDB        │
    │                           │     (deployment status)    │
    │                           │                            │
    │  Notify UI (WebSocket     │                            │
    │  or polling)              │                            │
    │◄──────────────────────────│                            │
```

## Deployment Plan Resolution

When a deployment is triggered, the orchestrator builds a plan:

### Input

```json
{
  "appId": "app_123",
  "instanceId": "inst_prod",
  "infraVersion": 3,
  "trigger": "manual",
  "triggeredBy": "user_abc"
}
```

### Plan Building Steps

1. **Load infra definition** — fetch version N of the app's infra spec/CDK source
2. **Resolve target agent** — look up which agent manages this instance
3. **Determine source** — if CDK, prepare source archive; if spec, generate CDK from spec
4. **Build step sequence** — based on pipeline definition (if exists) or default flow

### Default Flow (no pipeline defined)

```
1. Get upload URL from agent
2. Upload source archive to agent's S3
3. Synth (synth-infrastructure or synth-cdk-project depending on format)
4. Deploy stacks (deploy-stacks with synthesized templates)
```

### Pipeline Flow (pipeline defined)

The pipeline definition's steps are executed in order. Each step type maps to agent commands:

| Pipeline Step Type | Agent Commands |
|-------------------|---------------|
| `synth` | `get-upload-url` → upload → `synth-*` |
| `deploy` | `deploy-stacks` (using synth output) |
| `approval` | Pause execution, wait for user decision |
| `destroy` | `destroy-stacks` |
| `drift-check` | `detect-drift` |
| `preview` | `get-changeset` |
| `custom` | `start-execution` (user-defined state machine) |

## Agent Command Dispatch

### Dispatch Flow

```
Orchestrator SFN
    │
    │  1. Build command payload
    │     { commandId, callbackUrl, payload }
    │
    │  2. Assume backend IAM role
    │     (has execute-api:Invoke on agent API)
    │
    │  3. Sign request with SigV4
    │
    │  4. POST to agent API endpoint
    │     https://<agent-api>/v1/commands/<command>
    │
    │  5. Receive 202 Accepted
    │     { status: "accepted", messageId: "..." }
    │
    │  6. Wait for callback
    │     (SFN task token or polling pattern)
    │
    │  7. Callback arrives at /agent/callback
    │     { commandId, status, output }
    │
    │  8. Resume orchestration
```

### Callback URL Pattern

Each command sent to the agent includes a `callbackUrl` that the agent uses to report completion. This URL should include enough context for the backend to correlate the callback:

```
https://api.lonic.dev/agent/callback?deploymentId=deploy_456&stepOrder=3
```

Or use the `commandId` for correlation:
```
commandId: "deploy_456_step_3"
```

### IAM Setup for Agent Dispatch

The backend needs an IAM role that can invoke each agent's API Gateway:

```json
{
  "Effect": "Allow",
  "Action": "execute-api:Invoke",
  "Resource": "arn:aws:execute-api:*:*:*/v1/*"
}
```

This role ARN is passed as `backendRoleArn` when the agent stack is deployed.

## Approval Gates

### How Approvals Work

1. Orchestrator SFN reaches an approval step
2. SFN enters a **wait state** (using a task token or a polling pattern)
3. Backend stores the pending approval in DynamoDB
4. UI shows the pending approval to authorized approvers
5. Approver submits decision via `POST /pipeline/executions/:id/steps/:name/approve`
6. Backend sends a `SendTaskSuccess` or `SendTaskFailure` to resume the SFN execution
7. If approved, orchestration continues to the next step
8. If rejected, orchestration stops and deployment is marked as `rejected`

### Approval Timeout

Approvals should have a configurable timeout (e.g., 24 hours). If no decision is made:
- The SFN task times out
- Deployment is marked as `timed_out`
- Notification sent to approvers

### Multi-Approver Support

Pipeline steps can require multiple approvers:

```json
{
  "type": "approval",
  "approvers": ["user_abc", "user_def"],
  "requiredCount": 1,
  "timeout": "24h"
}
```

- `requiredCount: 1` — any one approver is sufficient
- `requiredCount: 2` — both must approve (all must approve)

## Rollback Strategy

### Automatic Rollback

If a deploy step fails:
1. Check the app's rollback policy (configurable)
2. If `auto_rollback: true`:
   - Determine the last known good infra version
   - Trigger a new deployment with that version
   - Mark the failed deployment as `rolled_back`
3. If `auto_rollback: false`:
   - Mark deployment as `failed`
   - Notify the user
   - User can manually trigger rollback

### Manual Rollback

```
POST /workspaces/:wsId/deployments/:deployId/rollback
{ "targetVersion": 2 }
```

This creates a new deployment using the specified infra version. It follows the same flow as a normal deployment (synth → deploy).

## Git-Triggered Deployments

### Flow

```
1. Customer pushes to git (GitHub, GitLab, Bitbucket, CodeCommit)

2. CodeStar Connection in customer's AWS account detects the push

3. EventBridge rule in customer's account fires

4. Agent receives the event and forwards to backend:
   POST /agent/callback
   {
     "type": "git_push",
     "agentId": "agent_abc",
     "repository": "owner/repo",
     "branch": "main",
     "commitSha": "abc1234567890",
     "commitMessage": "Fix auth bug",
     "author": "jane@example.com"
   }

5. Backend looks up which apps are connected to this repo + branch

6. For each matching app:
   a. Check if auto-deploy is enabled
   b. Check the pipeline definition
   c. Trigger deployment orchestration

7. Backend fetches the source from git (via the agent's CodeStar Connection)
   or triggers the agent to package and upload it
```

### Git Connection Setup

The git connection lives in the customer's AWS account (via CodeStar Connections / AWS CodeConnections). This keeps git credentials secure — the backend never touches them.

The agent stack may include:
- A CodeStar Connection resource
- An EventBridge rule for connection events
- A Lambda that forwards events to the backend

## Multi-Instance Deployments

When an app has multiple instances (e.g., per-tenant), deployments can target:

1. **Single instance** — deploy to one specific instance
2. **All instances** — deploy to every instance of the app (rolling or parallel)
3. **Instance group** — deploy to a subset (e.g., by tag or environment)

### Rolling Deployment Strategy

For multi-instance deployments:

```json
{
  "strategy": "rolling",
  "batchSize": 2,
  "pauseBetweenBatches": "5m",
  "rollbackOnFailure": true
}
```

1. Sort instances into batches of `batchSize`
2. Deploy to batch 1
3. Wait `pauseBetweenBatches`
4. Deploy to batch 2
5. If any batch fails and `rollbackOnFailure`, roll back all completed batches

## State Machine Design

The orchestrator uses Step Functions Standard workflows.

### Main Deployment State Machine

```
Start
  │
  ├── Load deployment context (DynamoDB)
  │
  ├── For each pipeline step:
  │    ├── synth → Dispatch synth command to agent, wait for callback
  │    ├── approval → Wait for user decision (task token)
  │    ├── deploy → Dispatch deploy-stacks to agent, wait for callback
  │    ├── destroy → Dispatch destroy-stacks to agent, wait for callback
  │    ├── drift-check → Dispatch detect-drift, wait for callback
  │    └── preview → Dispatch get-changeset, wait for callback
  │
  ├── Update deployment status in DynamoDB
  │
  ├── On failure:
  │    ├── Check rollback policy
  │    ├── If auto-rollback: trigger rollback deployment
  │    └── Notify user
  │
  └── End (success or failure)
```

### Timeout Configuration

| Operation | Timeout |
|-----------|---------|
| Overall deployment | Configurable (default: 2 hours) |
| Synth step | 30 minutes (agent-side) |
| Deploy step | 60 minutes (agent-side) |
| Approval step | 24 hours (configurable) |
| Agent dispatch (HTTP call) | 30 seconds |
| Callback wait | Matches agent-side timeout + buffer |
