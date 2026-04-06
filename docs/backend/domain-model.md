# Domain Model

## Entity Relationships

```
Organization
 ├── License (plan: personal_free | team | enterprise)
 ├── Billing config
 │
 └── Workspace (1..N, default auto-created)
      ├── User membership (role: owner | admin | member | viewer)
      │
      ├── Agent[] (registered in customer AWS accounts)
      │    ├── accountId, region, apiUrl, agentVersion
      │    ├── status: active | unreachable | updating | deregistered
      │    └── health: last heartbeat, error stats
      │
      ├── Template[] (references to shared or custom templates)
      │    └── e.g., ECS with auto-scaling + blue-green via CodeDeploy
      │
      ├── App[]
      │    ├── InfraDefinition (versioned)
      │    │    ├── format: spec | cdk | hybrid
      │    │    └── source: inline spec, git repo, uploaded archive
      │    │
      │    ├── PipelineDefinition (versioned)
      │    │    ├── format: spec | cdk
      │    │    ├── steps with optional approval gates
      │    │    └── trigger config (git push, manual, scheduled, API)
      │    │
      │    ├── GitConnection[]
      │    │    ├── lives in customer AWS account (CodeStar Connections)
      │    │    ├── agentId (which agent owns the connection)
      │    │    ├── repo, branch, trigger config
      │    │    └── event flow: git push → EventBridge → agent → backend
      │    │
      │    └── Instance[] (deployments of this app's infra)
      │         ├── agentId (target agent)
      │         ├── params (tenant config, env vars, overrides)
      │         ├── status: pending | provisioning | active | updating |
      │         │          destroying | failed | destroyed
      │         └── StackStatus[] (per-stack status, drift info)
      │
      └── Deployment[]
           ├── appId, instanceId (or multiple instances)
           ├── trigger: git_push | manual | api | scheduled
           ├── source: git commit SHA, uploaded archive URI
           ├── status: queued | in_progress | awaiting_approval |
           │          succeeded | failed | cancelled | rolled_back
           │
           └── PipelineExecution
                └── StepExecution[]
                     ├── type: synth | deploy | test | approval | custom
                     ├── status: pending | running | succeeded | failed |
                     │          awaiting_approval | approved | rejected
                     ├── agentCommandId (if dispatched to agent)
                     └── ApprovalGate (if type = approval)
                          ├── approvers: [userId]
                          ├── status: pending | approved | rejected
                          └── decidedBy, decidedAt, comment
```

## User Model

- Each user is identified by a **GID** (global identifier) from the Lonic SSO service
- One user belongs to exactly **one organization**
- Users have roles within workspaces (not org-level — allows per-workspace access control)
- Personal accounts: org with one user, one workspace, simplified UI

### User Roles

| Role | Permissions |
|------|------------|
| **owner** | Full control, billing, delete org/workspace, manage members |
| **admin** | Manage apps, agents, deployments, approve, manage members (except owner) |
| **member** | Create/edit apps, trigger deployments, view everything |
| **viewer** | Read-only access to all resources |

## DynamoDB Table Design

### Table: `lonic-core`

Primary entity store for orgs, workspaces, apps, instances, and related metadata.

**Key Schema:** `PK` (partition key), `SK` (sort key)

| Entity | PK | SK | Attributes |
|--------|----|----|-----------|
| Organization | `ORG#<orgId>` | `META` | name, plan, createdAt, billingConfig |
| Workspace | `ORG#<orgId>` | `WS#<wsId>` | name, createdAt, isDefault |
| User membership | `ORG#<orgId>` | `USER#<gid>` | role, joinedAt, email, displayName |
| App | `WS#<wsId>` | `APP#<appId>` | name, description, createdAt, updatedAt |
| InfraDefinition | `APP#<appId>` | `INFRA#<version>` | format, sourceType, spec/sourceUri, createdAt |
| PipelineDefinition | `APP#<appId>` | `PIPELINE#<version>` | format, steps, triggerConfig, createdAt |
| GitConnection | `APP#<appId>` | `GIT#<connId>` | agentId, repo, branch, triggerConfig |
| Instance | `APP#<appId>` | `INST#<instId>` | agentId, params, status, createdAt |
| StackStatus | `INST#<instId>` | `STACK#<stackName>` | status, driftStatus, lastDeployedAt |
| Template | `WS#<wsId>` | `TPL#<tplId>` | name, description, category, specUri |

**GSI1** — Query by workspace:
| Entity | GSI1PK | GSI1SK |
|--------|--------|--------|
| App | `WS#<wsId>` | `APP#<appId>` |
| Template | `WS#<wsId>` | `TPL#<tplId>` |

**GSI2** — Query by agent:
| Entity | GSI2PK | GSI2SK |
|--------|--------|--------|
| Instance | `AGENT#<agentId>` | `INST#<instId>` |
| GitConnection | `AGENT#<agentId>` | `GIT#<connId>` |

**GSI3** — Query user's org:
| Entity | GSI3PK | GSI3SK |
|--------|--------|--------|
| User membership | `USER#<gid>` | `ORG#<orgId>` |

### Table: `lonic-deployments`

High-write-volume table for deployments and pipeline executions. TTL for automatic cleanup of old records.

| Entity | PK | SK | Attributes |
|--------|----|----|-----------|
| Deployment | `INST#<instId>` | `DEPLOY#<timestamp>#<deployId>` | appId, trigger, sourceRef, status, startedAt, completedAt |
| StepExecution | `DEPLOY#<deployId>` | `STEP#<order>` | type, status, agentCommandId, startedAt, completedAt |
| ApprovalGate | `DEPLOY#<deployId>` | `APPROVAL#<stepOrder>` | approvers, status, decidedBy, decidedAt, comment |

**GSI1** — Query deployment by ID:
| Entity | GSI1PK | GSI1SK |
|--------|--------|--------|
| Deployment | `DEPLOY#<deployId>` | `META` |
| StepExecution | `DEPLOY#<deployId>` | `STEP#<order>` |

**GSI2** — Query by app (all instances' deployments):
| Entity | GSI2PK | GSI2SK |
|--------|--------|--------|
| Deployment | `APP#<appId>` | `DEPLOY#<timestamp>#<deployId>` |

**TTL:** `expiresAt` — configurable retention (e.g., 90 days for free, 1 year for paid)

### Table: `lonic-agents`

Agent registry with health and error history.

| Entity | PK | SK | Attributes |
|--------|----|----|-----------|
| Agent | `AGENT#<agentId>` | `META` | orgId, wsId, accountId, region, apiUrl, apiArn, callbackTokenSecretArn, agentVersion, status, registeredAt |
| Heartbeat | `AGENT#<agentId>` | `HB#<timestamp>` | healthy, details |
| ErrorReport | `AGENT#<agentId>` | `ERR#<timestamp>` | type, alarm, stats |
| PendingCommand | `AGENT#<agentId>` | `CMD#<commandId>` | command, status, dispatchedAt, completedAt |

**GSI1** — Query agents by workspace:
| Entity | GSI1PK | GSI1SK |
|--------|--------|--------|
| Agent | `WS#<wsId>` | `AGENT#<agentId>` |

**TTL:** On heartbeats and error reports (e.g., 30 days)

### Table: `lonic-auth`

Sessions, API keys, and license data.

| Entity | PK | SK | Attributes |
|--------|----|----|-----------|
| Session | `SESSION#<token>` | `META` | userGid, orgId, createdAt, expiresAt |
| API Key | `APIKEY#<keyHash>` | `META` | orgId, wsId, name, permissions, createdAt |
| License | `ORG#<orgId>` | `LICENSE` | plan, maxWorkspaces, maxAgents, maxApps, expiresAt |

**GSI1** — Query API keys by org:
| Entity | GSI1PK | GSI1SK |
|--------|--------|--------|
| API Key | `ORG#<orgId>` | `APIKEY#<keyHash>` |

**TTL:** On sessions (`expiresAt`)

## Access Pattern Summary

| Pattern | Table | Key/Index |
|---------|-------|-----------|
| Get org details | lonic-core | PK=`ORG#<id>`, SK=`META` |
| List workspaces in org | lonic-core | PK=`ORG#<id>`, SK begins_with `WS#` |
| List users in org | lonic-core | PK=`ORG#<id>`, SK begins_with `USER#` |
| Find user's org | lonic-core | GSI3: PK=`USER#<gid>` |
| List apps in workspace | lonic-core | GSI1: PK=`WS#<id>`, SK begins_with `APP#` |
| Get app with definitions | lonic-core | PK=`APP#<id>`, SK begins_with `INFRA#` / `PIPELINE#` / `GIT#` |
| List instances of an app | lonic-core | PK=`APP#<id>`, SK begins_with `INST#` |
| Find instances by agent | lonic-core | GSI2: PK=`AGENT#<id>` |
| List deployments for instance | lonic-deployments | PK=`INST#<id>`, SK begins_with `DEPLOY#` |
| Get deployment with steps | lonic-deployments | GSI1: PK=`DEPLOY#<id>` |
| List deployments for app | lonic-deployments | GSI2: PK=`APP#<id>` |
| Get agent details | lonic-agents | PK=`AGENT#<id>`, SK=`META` |
| List agents in workspace | lonic-agents | GSI1: PK=`WS#<id>` |
| Track pending commands | lonic-agents | PK=`AGENT#<id>`, SK begins_with `CMD#` |
| Validate session | lonic-auth | PK=`SESSION#<token>` |
| Validate API key | lonic-auth | PK=`APIKEY#<hash>` |
| Check license | lonic-auth | PK=`ORG#<id>`, SK=`LICENSE` |
