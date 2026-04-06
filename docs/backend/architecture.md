# Architecture

## System Overview

```
                        ┌─────────────────────────────────────┐
                        │         Lonic Cloud Backend          │
                        │                                     │
  ┌──────────┐          │  ┌───────────┐   ┌──────────────┐   │          ┌──────────────────┐
  │ Angular  │◄────────►│  │ API       │   │ Orchestrator │   │          │  Customer AWS    │
  │ SPA      │  REST    │  │ Gateway   │   │ (SFN + SQS)  │──────────►  │  Account         │
  │ (S3+CF)  │          │  │ (HTTP)    │   └──────────────┘   │  IAM    │  ┌────────────┐  │
  └──────────┘          │  └─────┬─────┘   ┌──────────────┐   │  auth   │  │   Agent    │  │
                        │        │         │  DynamoDB     │   │         │  │ (SFN+Lambda│  │
  ┌──────────┐          │  ┌─────▼─────┐   │  Tables       │   │◄────────│  │  +CodeBuild│  │
  │ External │◄────────►│  │ Rust      │──►│              │   │ Bearer  │  └────────────┘  │
  │ API      │  API     │  │ Lambdas   │   └──────────────┘   │ token   └──────────────────┘
  │ Consumer │  keys    │  └───────────┘   ┌──────────────┐   │
  └──────────┘          │                  │  S3 Buckets   │   │
                        │                  │  (artifacts)  │   │
  ┌──────────┐          │                  └──────────────┘   │
  │ Lonic    │◄────────►│                                     │
  │ SSO      │  verify  │                                     │
  └──────────┘  code    └─────────────────────────────────────┘
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| API | API Gateway (HTTP API) | Low latency, native IAM/Lambda integration, cheaper than REST API |
| Compute | Rust Lambdas (ARM64) | Performance, type safety, low cold starts, cost efficiency |
| Database | DynamoDB | Serverless, scales to zero, predictable performance |
| Storage | S3 | Specs, templates, CDK source archives, synth artifacts |
| Orchestration | Step Functions + SQS | Long-running deployment workflows, reliable dispatch to agents |
| Frontend | Angular SPA on S3 + CloudFront | No SSR needed (all behind auth), clean separation |
| Auth | HTTP-only session cookies + API keys + agent bearer tokens | Three consumer types, each with appropriate auth mechanism |
| IaC | AWS CDK (TypeScript) | Consistent with agent infra, uses lonic-cdk-commons |

## Repository Structure

```
lonic-cloud-backend/
├── cdk/
│   ├── bin/
│   │   └── app.ts                          # CDK app entry point
│   ├── lib/
│   │   └── stacks/
│   │       ├── data/
│   │       │   ├── DatabaseStack.ts        # DynamoDB tables
│   │       │   └── FileStorageStack.ts     # S3 buckets
│   │       ├── auth/
│   │       │   ├── AuthStack.ts            # Session/API key/license tables
│   │       │   └── AuthRuntimeStack.ts     # SSO callback, session mgmt Lambdas
│   │       ├── api/
│   │       │   ├── ApiGatewayStack.ts      # HTTP API, custom domain, WAF
│   │       │   ├── AppsApiStack.ts         # App CRUD Lambdas
│   │       │   ├── InfraApiStack.ts        # Infra specs, instances, templates
│   │       │   ├── PipelinesApiStack.ts    # Pipeline defs, executions, approvals
│   │       │   ├── DeploymentsApiStack.ts  # Deployment triggers, status, history
│   │       │   ├── AgentsApiStack.ts       # Agent registration, status, callbacks
│   │       │   └── AdminApiStack.ts        # Org/workspace/user mgmt, billing
│   │       ├── orchestration/
│   │       │   ├── DeploymentPipelineStack.ts  # SFN workflows for deployments
│   │       │   ├── AgentDispatchStack.ts       # SQS queues for agent commands
│   │       │   └── EventProcessingStack.ts     # EventBridge, agent callbacks
│   │       ├── frontend/
│   │       │   └── FrontendStack.ts        # S3, CloudFront, OAC
│   │       └── observability/
│   │           └── MonitoringStack.ts      # Dashboards, alarms, SNS
│   └── test/
├── lambdas/                                # Rust workspace
│   ├── Cargo.toml                          # Workspace root
│   ├── shared/                             # Shared crate
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── auth.rs                     # Session/API key/agent token validation
│   │       ├── db.rs                       # DynamoDB client, typed table access
│   │       ├── models.rs                   # Domain types (Org, App, Instance, etc.)
│   │       └── errors.rs                   # Error types, HTTP error responses
│   ├── api-apps/                           # App CRUD
│   ├── api-infra/                          # Infra specs, instances, provisioning
│   ├── api-pipelines/                      # Pipeline defs, executions, approvals
│   ├── api-deployments/                    # Deployment triggers, status, history
│   ├── api-agents/                         # Agent registration, callbacks
│   ├── api-admin/                          # Org, workspace, user, billing, license
│   ├── api-auth/                           # SSO callback, session management
│   ├── orchestrator/                       # SFN task handlers (deployment logic)
│   └── agent-callback/                     # Inbound callbacks from agents
├── frontend/                               # Angular workspace
│   ├── src/
│   └── angular.json
└── docs/
```

## Stack Decomposition

### Dependency Graph

```
DatabaseStack ─────────┐
FileStorageStack ──────┤
AuthStack ─────────────┤
                       ▼
               ApiGatewayStack
               │    │    │    │
  ┌────────────┤    │    │    ├────────────────┐
  ▼            ▼    ▼    ▼    ▼                ▼
AppsApi   InfraApi  PipelinesApi  AgentsApi  AdminApi
                    DeploymentsApi
                         │         │
                         ▼         ▼
                  DeploymentPipelineStack
                  AgentDispatchStack
                  EventProcessingStack

AuthRuntimeStack ──► ApiGatewayStack (authorizer Lambda)

FrontendStack (independent)
MonitoringStack (reads from everything)
```

### Stack Details

| Stack | Resources | Deploy Frequency |
|-------|-----------|-----------------|
| **DatabaseStack** | DynamoDB tables (lonic-core, lonic-deployments, lonic-agents) | Rare (schema changes only) |
| **FileStorageStack** | S3 buckets (specs, templates, artifacts, frontend assets) | Rare |
| **AuthStack** | DynamoDB tables (lonic-sessions), Secrets Manager | Rare |
| **AuthRuntimeStack** | SSO callback Lambda, session management Lambda, authorizer Lambda | Moderate |
| **ApiGatewayStack** | HTTP API, custom domain, WAF rules, throttling config | Moderate |
| **AppsApiStack** | App CRUD Lambdas (create, read, update, delete, list) | Frequent |
| **InfraApiStack** | Infra spec Lambdas, instance provisioning, template management | Frequent |
| **PipelinesApiStack** | Pipeline definition Lambdas, execution management, approval gates | Frequent |
| **DeploymentsApiStack** | Deployment trigger, status, history, rollback Lambdas | Frequent |
| **AgentsApiStack** | Agent registration, status, callback receiver Lambdas | Moderate |
| **AdminApiStack** | Org/workspace/user/billing/license Lambdas | Moderate |
| **DeploymentPipelineStack** | Step Functions state machines for deployment orchestration | Moderate |
| **AgentDispatchStack** | SQS queues for agent command dispatch, DLQ, retry policies | Rare |
| **EventProcessingStack** | EventBridge rules for agent callbacks, async event processing | Moderate |
| **FrontendStack** | S3 bucket, CloudFront distribution, OAC, Route53 records | On frontend deploys |
| **MonitoringStack** | CloudWatch dashboards, alarms, SNS topics | Rare |

### Splitting Principles

1. **Stateful resources isolated** — DynamoDB tables and S3 buckets in their own stacks with deletion protection. Never risk them during a Lambda deploy.
2. **One stack per API domain** — Each domain (apps, infra, pipelines, etc.) owns its Lambdas and IAM roles. Adding an endpoint to infra only deploys `InfraApiStack`.
3. **Shared API Gateway** — Single HTTP API in `ApiGatewayStack`. Other stacks import it and add routes.
4. **Orchestration separate from request/response** — Step Functions and SQS have different scaling and timeout characteristics than API Lambdas.
5. **Frontend independent** — Completely separate lifecycle from backend.
