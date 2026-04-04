# lonic — Summary

> Distilled overview for quick context. See [library-and-service-overview.md](./library-and-service-overview.md) for full implementation details.

---

## The Library (open source, free)

**lonic-cdk-commons** is a TypeScript AWS CDK library for declaratively defining CI/CD pipelines and infrastructure. Use it with JSON specs (designed for visual editors) or directly in TypeScript with high-level constructs. Either way, it eliminates the pain of working with raw CDK Step Functions and CloudFormation.

### What it provides

**Spec-driven builders:**
- `PipelineBuilder` &mdash; JSON spec &rarr; AWS Step Functions state machines. Handles step wiring, variable scoping, branching, and condition compilation.
- `InfrastructureBuilder` &mdash; JSON spec &rarr; CDK stacks with typed blocks. Handles cross-stack refs, validation, and dependency ordering.

**Pipeline constructs** &mdash; pre-built, composable step types (usable via specs or directly in TypeScript):

| Construct | What it does |
|---|---|
| `SourceStep` | Clones a Git repo (GitHub/GitLab/Bitbucket), uploads to S3. Webhook triggers, commit tag rules, git tag triggers, PR triggers, commit status reporting. |
| `SynthStep` | Runs `cdk synth` to produce CloudFormation templates. |
| `RunCodeBuildStep` | Runs arbitrary shell commands in CodeBuild. Exports env vars as workflow variables. |
| `BuildDockerStep` | Builds a Docker image and pushes to ECR. |
| `DeployStacksStep` | Deploys CDK stacks via CloudFormation change sets. |
| `DeployEcsServiceStep` | Rolling update of an ECS service with a new container image. |
| `CodeDeployDeploymentStep` | CodeDeploy deployment to EC2/on-prem instances. |
| `BuildAmiStep` | Polls an EC2 Image Builder pipeline for completion. |

**Step Functions primitives** &mdash; a much better way to define state machines than raw CDK:
- `Variable` / `VariableScope` &mdash; workflow-scoped variables with scope isolation (no name collisions across branches).
- `Resolvable` &mdash; typed interface for values embeddable in JSONata expressions.
- `Step<TOutputs, TVars>` &mdash; typed state wrapper that tracks outputs and accumulated variables through `.next()` chains. Supports branch joining, typed outputs, and automatic variable accumulation.
- `ConstructStep` &mdash; base class for custom pipeline steps.
- Control flow: `choice` (conditional branching with structured conditions, JSONata expressions, or raw JSONata), `succeed`, `fail`.

**Infrastructure constructs:**
- Pre-built block types: VPC, security group, EC2 instance, ECS cluster, ECS Fargate service, ECR repository, Lambda function, S3 bucket, RDS instance, RDS subnet group.
- `ConstructRegistry` for registering custom block types.

**Cross-stack helpers:**
- `StackOutput` / `StackInput` &mdash; ergonomic SSM Parameter Store-based cross-stack export/import. No more fighting with `CfnOutput` and `Fn.importValue`.

**Extensible:** consumers register custom step types via `defineStepHandler()` and custom block types via `ConstructRegistry`.

### Key design choices

- **Spec-driven:** all configuration is serializable JSON &mdash; designed to be produced by a visual editor or written by hand. Teams that prefer TypeScript can use the constructs directly.
- **Build-time only:** the library generates CloudFormation and disappears. No runtime components, no state, no data plane.
- **Pipeline metadata** (step IDs, types, construct paths) is attached as CDK metadata and the state machine construct is exposed, so external tooling can build observability on top.
- **Adoption flywheel:** teams start with the library and `cdk deploy`. When they outgrow manual management, their existing specs work with the paid service &mdash; zero migration.

---

## The Service (paid)

A managed infrastructure platform built on top of the library. The library provides everything needed to define and deploy (constructs, builders, specs). The service provides **run-time operations** on top: lifecycle management, multi-tenancy, governance, and a dashboard.

### Core capabilities

**1. Project onboarding &mdash; three entry points:**
- **Spec-based:** connect a repo with `PipelineSpec` / `InfrastructureSpec` JSON.
- **Bring-your-own CDK:** connect any CDK project &mdash; even without the library. The service discovers stacks and adds the operational layer on top.
- **Visual editors:** define pipelines and infrastructure through drag-and-drop UIs that produce spec JSON.

**2. Environment management:**
Environments (dev, staging, prod) with config overrides, promotion workflows, approval gates, and environment-scoped secrets.

**3. Tenant instance management** (key differentiator)**:**
For single-tenant SaaS &mdash; each customer gets isolated infrastructure derived from a shared template.
- Provision, update, scale, and decommission tenant instances.
- Bulk rollouts with canary/rolling strategies.
- Track deployed version, health, and drift per tenant.

**4. API-driven provisioning:**
REST API for programmatic infrastructure lifecycle:
- `POST /tenants` &mdash; provision (customer signs up &rarr; infra is created).
- `PATCH /tenants/:id` &mdash; update config (customer upgrades &rarr; infra scales).
- `DELETE /tenants/:id` &mdash; deprovision (customer churns &rarr; infra is cleaned up).
- `POST /rollout` &mdash; roll out new version to all tenants.
- Webhook callbacks for lifecycle events.

**5. Automatic deployment pipelines:**
Infrastructure changes (visual editor, spec update, or tenant provisioning) automatically generate and execute the right pipeline. No manual pipeline authoring needed.

**6. Operations:**
- Deployment history with diff views.
- One-click rollback (forward-deploy of previous version).
- Drift detection per environment and tenant.
- Real-time pipeline monitoring with per-step status.
- Cost tracking per environment and tenant via auto-applied cost allocation tags.

**7. Governance:**
RBAC, approval workflows, audit logging, policy guardrails.

### Architecture

```
Hosted backend (closed infra)         Customer's AWS account
┌────────────────────────────┐        ┌──────────────────────────┐
│  API, dashboard, auth,     │        │  Agent (open source,     │
│  tenant state, deployment  │ ─cmd─> │  self-hosted)            │
│  orchestration, billing    │ <─evt─ │                          │
│                            │        │  Runs CDK synth/deploy   │
│  Code: open source         │        │  using local IAM role.   │
│  Infra: hosted by lonic    │        │  Credentials never leave │
└────────────────────────────┘        │  the account.            │
                                      └──────────────────────────┘
```

**Hosted backend** &mdash; the control plane. Owns all state (deployment history, tenant registry, environment config, audit logs), orchestration, dashboard, and API. Code is open source for auditability; infrastructure is hosted by lonic as the paid product.

**Agent** &mdash; a lightweight, stateless executor deployed into the customer's AWS account via `cdk deploy`. Fully open source. Imports the library as a dependency, receives commands from the backend, runs CDK synth/deploy with a scoped IAM role, streams status back. Customer credentials and code never leave their account. See [agent-design.md](./agent-design.md) for details.

### What lives where

| Component | Where | Why |
|---|---|---|
| Everything: constructs, builders, spec format, primitives | Library (open source, free) | Adoption engine &mdash; teams start here, specs are the on-ramp to the service |
| Command receiver, executor, status reporter | Agent (open source, free) | Thin glue between backend and library |
| State, orchestration, dashboard, API, billing | Backend (open code, paid hosting) | The paid product |

### What's open, what's closed

| Component | Source | Hosting | Why |
|---|---|---|---|
| Library | Open source | npm package | Adoption engine, free forever |
| Agent | Open source | Customer's account | Trust &mdash; customers must audit what touches their AWS |
| Backend code | Open source | Hosted by lonic | Auditability &mdash; customers can verify what the control plane does |
| Backend infra | Closed | Hosted by lonic | The paid product &mdash; database, state, uptime, managed experience |

### Why this works

The library solves "how do I define pipelines and infrastructure declaratively?" &mdash; specs, builders, constructs, primitives. Free, self-contained, useful on its own. Teams start here, write specs, deploy with `cdk deploy`.

The service solves "how do I manage infrastructure across environments and tenants over time?" &mdash; a run-time problem that compounds with scale. Because the service uses the same spec format as the library, teams that already have specs can adopt the service with zero migration cost.

Trust-sensitive parts (agent, backend code) are open source. Operationally-heavy parts (hosting, state, uptime) are the paid product. Customers pay for the managed experience, not for access to the code.
