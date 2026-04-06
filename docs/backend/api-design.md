# Backend API Design

REST API exposed by the Lonic Cloud backend to the Angular SPA (via session cookies) and programmatic consumers (via API keys).

**Base URL:** `https://api.lonic.dev/v1`

## Authentication Headers

| Consumer | Header |
|----------|--------|
| Web UI | `Cookie: session=<token>` (automatic) |
| API consumer | `X-Api-Key: lonic_key_...` |
| Agent callback | `Authorization: Bearer <callbackToken>` |

## Common Response Patterns

**Success:**
```json
{
  "data": { ... }
}
```

**List with pagination:**
```json
{
  "data": [ ... ],
  "nextToken": "<opaque_cursor_or_null>"
}
```

**Error:**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "App not found"
  }
}
```

**Standard HTTP status codes:** 200 (OK), 201 (Created), 204 (No Content), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 409 (Conflict), 429 (Rate Limited), 500 (Internal Error).

---

## Auth Endpoints

### SSO Callback

```
POST /auth/callback

{
  "code": "<auth_code_from_sso_redirect>"
}

Response (200):
Set-Cookie: session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800

{
  "data": {
    "userGid": "user_abc123",
    "email": "jane@example.com",
    "displayName": "Jane Doe",
    "orgId": "org_xyz",
    "orgName": "Acme Corp"
  }
}
```

### Get Current User

```
GET /auth/me

Response (200):
{
  "data": {
    "userGid": "user_abc123",
    "email": "jane@example.com",
    "displayName": "Jane Doe",
    "orgId": "org_xyz",
    "orgName": "Acme Corp",
    "workspaces": [
      { "id": "ws_default", "name": "Default", "role": "owner" },
      { "id": "ws_staging", "name": "Staging", "role": "admin" }
    ]
  }
}
```

### Logout

```
POST /auth/logout

Response (204):
Set-Cookie: session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0
```

---

## Organization & Workspace Endpoints

### Get Organization

```
GET /org

Response (200):
{
  "data": {
    "id": "org_xyz",
    "name": "Acme Corp",
    "plan": "team",
    "createdAt": "2024-01-01T00:00:00Z",
    "license": {
      "plan": "team",
      "maxWorkspaces": 5,
      "maxAgents": 10,
      "expiresAt": "2025-12-31T23:59:59Z"
    }
  }
}
```

### Update Organization

```
PATCH /org

{
  "name": "Acme Corporation"
}

Response (200):
{
  "data": { ... updated org ... }
}
```

### List Workspaces

```
GET /workspaces

Response (200):
{
  "data": [
    { "id": "ws_default", "name": "Default", "isDefault": true, "createdAt": "..." },
    { "id": "ws_staging", "name": "Staging", "isDefault": false, "createdAt": "..." }
  ]
}
```

### Create Workspace

```
POST /workspaces

{
  "name": "Production"
}

Response (201):
{
  "data": { "id": "ws_prod", "name": "Production", "isDefault": false, "createdAt": "..." }
}
```

### Update / Delete Workspace

```
PATCH  /workspaces/:wsId    { "name": "New Name" }
DELETE /workspaces/:wsId    (cannot delete default workspace)
```

---

## Member Management

### List Members

```
GET /workspaces/:wsId/members

Response (200):
{
  "data": [
    { "userGid": "user_abc", "email": "jane@example.com", "displayName": "Jane", "role": "owner" },
    { "userGid": "user_def", "email": "john@example.com", "displayName": "John", "role": "member" }
  ]
}
```

### Invite Member

```
POST /workspaces/:wsId/members

{
  "email": "newuser@example.com",
  "role": "member"
}

Response (201):
{
  "data": { "userGid": "user_ghi", "email": "newuser@example.com", "role": "member", "status": "invited" }
}
```

### Update Role / Remove Member

```
PATCH  /workspaces/:wsId/members/:userGid   { "role": "admin" }
DELETE /workspaces/:wsId/members/:userGid
```

---

## App Endpoints

All app endpoints are scoped to a workspace via the `X-Workspace-Id` header or query parameter.

### List Apps

```
GET /workspaces/:wsId/apps?nextToken=<cursor>

Response (200):
{
  "data": [
    {
      "id": "app_123",
      "name": "My Web App",
      "description": "ECS-based web application",
      "infraFormat": "spec",
      "pipelineFormat": "spec",
      "instanceCount": 3,
      "createdAt": "2024-01-10T00:00:00Z",
      "updatedAt": "2024-01-15T12:00:00Z"
    }
  ],
  "nextToken": null
}
```

### Create App

```
POST /workspaces/:wsId/apps

{
  "name": "My Web App",
  "description": "ECS-based web application"
}

Response (201):
{
  "data": {
    "id": "app_123",
    "name": "My Web App",
    "description": "ECS-based web application",
    "createdAt": "2024-01-10T00:00:00Z"
  }
}
```

### Get / Update / Delete App

```
GET    /workspaces/:wsId/apps/:appId
PATCH  /workspaces/:wsId/apps/:appId   { "name": "Updated Name" }
DELETE /workspaces/:wsId/apps/:appId
```

---

## Infra Endpoints

### Set Infra Definition

```
PUT /workspaces/:wsId/apps/:appId/infra

{
  "format": "spec",
  "spec": {
    "resources": [ ... ]
  }
}

-- or for CDK --

{
  "format": "cdk",
  "sourceUri": "s3://bucket/uploads/uuid/source.zip"
}

-- or for hybrid --

{
  "format": "hybrid",
  "sourceUri": "s3://bucket/uploads/uuid/source.zip"
}

Response (200):
{
  "data": {
    "version": 3,
    "format": "spec",
    "createdAt": "2024-01-15T12:00:00Z"
  }
}
```

### Get Infra Definition

```
GET /workspaces/:wsId/apps/:appId/infra?version=<n>

Response (200):
{
  "data": {
    "version": 3,
    "format": "spec",
    "spec": { ... },
    "createdAt": "2024-01-15T12:00:00Z"
  }
}
```

### List Infra Versions

```
GET /workspaces/:wsId/apps/:appId/infra/versions

Response (200):
{
  "data": [
    { "version": 3, "format": "spec", "createdAt": "2024-01-15T12:00:00Z" },
    { "version": 2, "format": "spec", "createdAt": "2024-01-10T08:00:00Z" },
    { "version": 1, "format": "spec", "createdAt": "2024-01-05T10:00:00Z" }
  ]
}
```

### List Templates

```
GET /workspaces/:wsId/templates

Response (200):
{
  "data": [
    {
      "id": "tpl_ecs_bg",
      "name": "ECS with Blue-Green Deployments",
      "description": "ECS Fargate service with auto-scaling and CodeDeploy blue-green deployments",
      "category": "compute",
      "builtIn": true
    }
  ]
}
```

### Get Template

```
GET /workspaces/:wsId/templates/:tplId

Response (200):
{
  "data": {
    "id": "tpl_ecs_bg",
    "name": "ECS with Blue-Green Deployments",
    "spec": { ... full spec ... },
    "parameters": [
      { "name": "serviceName", "type": "string", "required": true },
      { "name": "desiredCount", "type": "number", "default": 2 }
    ]
  }
}
```

---

## Instance Endpoints

### List Instances

```
GET /workspaces/:wsId/apps/:appId/instances

Response (200):
{
  "data": [
    {
      "id": "inst_prod",
      "agentId": "agent_abc",
      "params": { "tenantId": "acme", "environment": "production" },
      "status": "active",
      "stacks": [
        { "name": "NetworkStack", "status": "CREATE_COMPLETE", "driftStatus": "IN_SYNC" },
        { "name": "AppStack", "status": "UPDATE_COMPLETE", "driftStatus": "DRIFTED" }
      ],
      "createdAt": "2024-01-10T00:00:00Z",
      "lastDeployedAt": "2024-01-15T12:00:00Z"
    }
  ]
}
```

### Provision Instance

```
POST /workspaces/:wsId/apps/:appId/instances

{
  "agentId": "agent_abc",
  "params": {
    "tenantId": "acme",
    "environment": "production"
  }
}

Response (202):
{
  "data": {
    "id": "inst_prod",
    "status": "provisioning",
    "deploymentId": "deploy_xyz"
  }
}
```

This triggers a deployment orchestration flow in the backend.

### Update Instance (Redeploy)

```
POST /workspaces/:wsId/apps/:appId/instances/:instId/deploy

{
  "infraVersion": 3,
  "params": { "desiredCount": 4 }
}

Response (202):
{
  "data": {
    "deploymentId": "deploy_abc",
    "status": "queued"
  }
}
```

### Destroy Instance

```
DELETE /workspaces/:wsId/apps/:appId/instances/:instId

Response (202):
{
  "data": {
    "status": "destroying",
    "deploymentId": "deploy_del"
  }
}
```

### Check Drift

```
POST /workspaces/:wsId/apps/:appId/instances/:instId/drift

Response (202):
{
  "data": {
    "status": "detecting",
    "commandId": "cmd_drift_123"
  }
}
```

---

## Pipeline Endpoints

### Set Pipeline Definition

```
PUT /workspaces/:wsId/apps/:appId/pipeline

{
  "format": "spec",
  "steps": [
    { "name": "synth", "type": "synth" },
    { "name": "review", "type": "approval", "approvers": ["user_abc"] },
    { "name": "deploy-staging", "type": "deploy", "instanceIds": ["inst_staging"] },
    { "name": "approve-prod", "type": "approval", "approvers": ["user_abc", "user_def"] },
    { "name": "deploy-prod", "type": "deploy", "instanceIds": ["inst_prod"] }
  ],
  "triggerConfig": {
    "gitPush": { "branch": "main", "enabled": true },
    "manual": { "enabled": true },
    "scheduled": null
  }
}

Response (200):
{
  "data": { "version": 2, "createdAt": "..." }
}
```

### Get Pipeline Definition

```
GET /workspaces/:wsId/apps/:appId/pipeline

Response (200):
{
  "data": {
    "version": 2,
    "format": "spec",
    "steps": [ ... ],
    "triggerConfig": { ... }
  }
}
```

### Trigger Pipeline Execution

```
POST /workspaces/:wsId/apps/:appId/pipeline/execute

{
  "trigger": "manual",
  "infraVersion": 3
}

Response (202):
{
  "data": {
    "executionId": "exec_123",
    "deploymentId": "deploy_456",
    "status": "queued"
  }
}
```

### List Pipeline Executions

```
GET /workspaces/:wsId/apps/:appId/pipeline/executions?nextToken=<cursor>

Response (200):
{
  "data": [
    {
      "executionId": "exec_123",
      "trigger": "git_push",
      "sourceRef": "abc1234",
      "status": "awaiting_approval",
      "currentStep": "approve-prod",
      "startedAt": "2024-01-15T12:00:00Z",
      "steps": [
        { "name": "synth", "status": "succeeded", "duration": 120 },
        { "name": "review", "status": "approved", "approvedBy": "user_abc" },
        { "name": "deploy-staging", "status": "succeeded", "duration": 300 },
        { "name": "approve-prod", "status": "pending" },
        { "name": "deploy-prod", "status": "pending" }
      ]
    }
  ],
  "nextToken": null
}
```

### Get Pipeline Execution

```
GET /workspaces/:wsId/apps/:appId/pipeline/executions/:execId
```

### Approve / Reject Step

```
POST /workspaces/:wsId/apps/:appId/pipeline/executions/:execId/steps/:stepName/approve

{
  "decision": "approved",
  "comment": "Looks good, ship it"
}

Response (200):
{
  "data": {
    "stepName": "approve-prod",
    "status": "approved",
    "decidedBy": "user_abc",
    "decidedAt": "2024-01-15T14:00:00Z"
  }
}
```

### Cancel Execution

```
POST /workspaces/:wsId/apps/:appId/pipeline/executions/:execId/cancel

Response (200):
{
  "data": { "status": "cancelled" }
}
```

---

## Deployment Endpoints

### List Deployments (across all instances in an app)

```
GET /workspaces/:wsId/apps/:appId/deployments?nextToken=<cursor>

Response (200):
{
  "data": [
    {
      "id": "deploy_456",
      "instanceId": "inst_prod",
      "trigger": "manual",
      "status": "succeeded",
      "infraVersion": 3,
      "startedAt": "2024-01-15T12:00:00Z",
      "completedAt": "2024-01-15T12:10:00Z",
      "duration": 600
    }
  ],
  "nextToken": null
}
```

### Get Deployment Detail

```
GET /workspaces/:wsId/deployments/:deployId

Response (200):
{
  "data": {
    "id": "deploy_456",
    "appId": "app_123",
    "instanceId": "inst_prod",
    "agentId": "agent_abc",
    "trigger": "manual",
    "status": "succeeded",
    "infraVersion": 3,
    "steps": [
      {
        "order": 1,
        "type": "synth",
        "status": "succeeded",
        "agentCommandId": "cmd_synth_789",
        "startedAt": "...",
        "completedAt": "...",
        "output": { "ArtifactUri": "s3://...", "Stacks": [...] }
      },
      {
        "order": 2,
        "type": "deploy",
        "status": "succeeded",
        "agentCommandId": "cmd_deploy_012",
        "stacks": [
          { "name": "NetworkStack", "status": "UPDATE_COMPLETE" },
          { "name": "AppStack", "status": "UPDATE_COMPLETE" }
        ]
      }
    ],
    "startedAt": "2024-01-15T12:00:00Z",
    "completedAt": "2024-01-15T12:10:00Z"
  }
}
```

### Rollback Deployment

```
POST /workspaces/:wsId/deployments/:deployId/rollback

{
  "targetVersion": 2
}

Response (202):
{
  "data": {
    "deploymentId": "deploy_rollback_789",
    "status": "queued"
  }
}
```

---

## Agent Endpoints (Backend-side)

### List Agents

```
GET /workspaces/:wsId/agents

Response (200):
{
  "data": [
    {
      "id": "agent_abc",
      "accountId": "123456789012",
      "region": "eu-west-1",
      "agentVersion": "0.1.0",
      "status": "active",
      "lastHeartbeat": "2024-01-15T12:30:00Z",
      "instanceCount": 3
    }
  ]
}
```

### Get Agent Detail

```
GET /workspaces/:wsId/agents/:agentId

Response (200):
{
  "data": {
    "id": "agent_abc",
    "accountId": "123456789012",
    "region": "eu-west-1",
    "apiUrl": "https://abc123.execute-api.eu-west-1.amazonaws.com/v1",
    "agentVersion": "0.1.0",
    "status": "active",
    "lastHeartbeat": "2024-01-15T12:30:00Z",
    "health": {
      "healthy": true,
      "totalErrors": 0,
      "functions": { ... }
    },
    "instances": [
      { "id": "inst_prod", "appId": "app_123", "appName": "My Web App", "status": "active" }
    ]
  }
}
```

### Generate Agent Setup

```
POST /workspaces/:wsId/agents/setup

{
  "accountId": "123456789012",
  "region": "eu-west-1"
}

Response (201):
{
  "data": {
    "agentId": "agent_abc",
    "setupToken": "tok_xyz789",
    "templateUrl": "https://lonic-templates.s3.amazonaws.com/agent/v0.1.0/template.json",
    "stackName": "LonicCloudAgent",
    "parameters": {
      "AgentId": "agent_abc",
      "SetupToken": "tok_xyz789"
    },
    "quickCreateUrl": "https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?stackName=LonicCloudAgent&templateURL=...&param_AgentId=agent_abc&param_SetupToken=tok_xyz789"
  }
}
```

Returns everything needed to deploy the agent stack in the customer's account — including a CloudFormation Quick Create URL for one-click deployment.

### Delete Agent

```
DELETE /workspaces/:wsId/agents/:agentId

Response (204)
```

---

## Agent Callback Endpoints (received by backend)

These are the endpoints the agent calls back to. Documented here for completeness — see [Agent Protocol](agent-protocol.md) for full details.

```
POST /agent/register           # Agent registration (setup token → callback token)
POST /agent/deregister         # Agent deregistration (stack deletion)
POST /agent/callback           # Command completion callback (bearer token auth)
POST /agent/runtime-error      # Real-time alarm notification (bearer token auth)
POST /agent/error-stats        # Scheduled error stats push (bearer token auth)
```

---

## API Key Management

### Create API Key

```
POST /api-keys

{
  "name": "CI/CD Pipeline",
  "wsId": "ws_prod",
  "permissions": ["read:apps", "write:deployments", "read:agents"]
}

Response (201):
{
  "data": {
    "id": "key_abc",
    "key": "lonic_key_abc123def456...",
    "name": "CI/CD Pipeline",
    "wsId": "ws_prod",
    "permissions": ["read:apps", "write:deployments", "read:agents"],
    "createdAt": "2024-01-15T12:00:00Z"
  }
}
```

**Important:** The `key` field is returned only once at creation time. It is not stored in plaintext.

### List API Keys

```
GET /api-keys

Response (200):
{
  "data": [
    {
      "id": "key_abc",
      "name": "CI/CD Pipeline",
      "wsId": "ws_prod",
      "permissions": [...],
      "createdAt": "...",
      "lastUsedAt": "..."
    }
  ]
}
```

### Revoke API Key

```
DELETE /api-keys/:keyId

Response (204)
```

---

## Statistics & Reports

### Deployment Statistics

```
GET /workspaces/:wsId/stats/deployments?period=30d

Response (200):
{
  "data": {
    "period": "30d",
    "totalDeployments": 142,
    "succeeded": 130,
    "failed": 8,
    "cancelled": 4,
    "averageDuration": 312,
    "byApp": [
      { "appId": "app_123", "appName": "My Web App", "deployments": 45 },
      { "appId": "app_456", "appName": "API Service", "deployments": 97 }
    ],
    "byDay": [
      { "date": "2024-01-15", "succeeded": 5, "failed": 1 },
      { "date": "2024-01-14", "succeeded": 3, "failed": 0 }
    ]
  }
}
```

### Agent Health Summary

```
GET /workspaces/:wsId/stats/agents

Response (200):
{
  "data": {
    "totalAgents": 3,
    "healthy": 2,
    "unhealthy": 1,
    "agents": [
      { "id": "agent_abc", "region": "eu-west-1", "healthy": true, "totalErrors24h": 0 },
      { "id": "agent_def", "region": "us-east-1", "healthy": true, "totalErrors24h": 0 },
      { "id": "agent_ghi", "region": "ap-southeast-1", "healthy": false, "totalErrors24h": 12 }
    ]
  }
}
```
