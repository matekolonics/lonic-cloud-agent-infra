# Agent Design

The agent is a lightweight, stateless executor that runs in the customer's AWS account. It receives commands from the hosted backend, executes CDK operations using a locally scoped IAM role, and streams status and logs back. Customer credentials, source code, and secrets never leave the account.

> See [library-and-service-overview.md](./library-and-service-overview.md) for full context on the library and service architecture.

---

## Why the agent exists

The service needs to deploy and manage infrastructure in customer AWS accounts. There are two ways to do this:

1. **Cross-account IAM role assumed by the backend.** The backend runs CDK synth/deploy directly using assumed credentials. Simpler, but the backend now handles customer credentials and source code. Hard to earn trust.

2. **Agent in the customer's account.** The backend sends declarative commands; the agent executes them locally. The backend never sees credentials or code. The agent is open source — customers can audit every line.

We chose option 2. The trust boundary is the network: the backend sends instructions ("deploy stack X with config Y"), the agent does the privileged work.

---

## What the agent is

A small CDK stack deployed into the customer's AWS account. It consists of:

- **Command receiver** — an API endpoint (API Gateway + Lambda, or SQS queue) that accepts commands from the hosted backend. Authenticated via a shared secret or mutual TLS established during initial setup.
- **Executor** — the core logic that processes commands. Runs CDK synth and deploy operations, CloudFormation API calls, and stack management tasks.
- **Status reporter** — streams execution status, step progress, and logs back to the hosted backend (via HTTPS callbacks or an EventBridge → API Gateway path).
- **IAM role** — a scoped role that the executor assumes. Permissions are limited to what's needed for the operations the agent performs (CloudFormation, S3, CodeBuild, ECS, etc.). The customer controls this role and can restrict it further.

**Key properties:**
- **Stateless.** All state (deployment history, tenant registry, environment config) lives in the hosted backend. The agent can be torn down and redeployed without data loss.
- **Open source.** Customers can read every line of code, fork it, audit it. This is a hard requirement for trust.
- **Self-updating.** The backend can instruct the agent to update itself to a new version (the agent deploys its own CDK stack).
- **Small.** The agent is not a platform — it's a thin executor. It doesn't make decisions about what to deploy or when. It follows instructions.

---

## What the agent does

### Core commands

The agent receives commands from the backend and executes them. Each command is a self-contained unit of work.

**Spec-based operations** (uses the PipelineBuilder / InfrastructureBuilder):
- `synth-pipeline` — accepts a PipelineSpec, runs PipelineBuilder via CDK synth, produces CloudFormation templates.
- `synth-infrastructure` — accepts an InfrastructureSpec, runs InfrastructureBuilder via CDK synth, produces CloudFormation templates.
- `deploy-stacks` — deploys one or more synthesised CloudFormation stacks (via change sets).
- `destroy-stacks` — tears down stacks in dependency-aware order.

**CDK project operations** (for bring-your-own CDK projects):
- `synth-cdk-project` — clones the customer's repo (from S3 or CodeBuild), runs `cdk synth`, produces templates.
- `discover-stacks` — runs `cdk ls` or parses `cdk.out` to discover the stack topology.
- `deploy-stacks` — same as above, works with any CDK output.

**Stack management:**
- `describe-stacks` — returns the current state of specified stacks (status, outputs, parameters, resources).
- `detect-drift` — runs CloudFormation drift detection on specified stacks.
- `get-changeset` — creates a change set without executing it (for preview/diff).

**Pipeline operations:**
- `start-execution` — starts a Step Functions state machine execution with given input.
- `get-execution-status` — returns the current state of an execution.

### Command format

Commands are JSON messages with a common envelope:

```json
{
  "commandId": "cmd-abc123",
  "type": "synth-pipeline",
  "payload": {
    "spec": { "version": "1", "pipelines": [...] },
    "environment": "production",
    "parameters": { "instanceSize": "large" }
  },
  "callbackUrl": "https://api.lonic.dev/agent/callback/cmd-abc123"
}
```

The agent processes the command and posts status updates to the callback URL:

```json
{
  "commandId": "cmd-abc123",
  "status": "IN_PROGRESS",
  "step": "deploying stack AppStack (2/3)",
  "timestamp": "2026-04-03T14:30:00Z"
}
```

```json
{
  "commandId": "cmd-abc123",
  "status": "SUCCEEDED",
  "outputs": {
    "stacks": [
      { "name": "AppStack", "status": "CREATE_COMPLETE", "outputs": { "ServiceUrl": "..." } }
    ]
  },
  "timestamp": "2026-04-03T14:32:00Z"
}
```

### Error handling

- Commands that fail report the error back to the backend with the full error message and (if applicable) the CloudFormation event log.
- The agent does not retry — the backend decides whether and when to retry.
- If the agent itself crashes or becomes unreachable, the backend detects this via missing heartbeats and marks the command as timed out.

---

## What the agent owns and doesn't own

The agent is a **thin executor**. It does not contain the spec-driven builders, the spec format, or any CDK construct logic. All of that lives in the **library** (lonic-cdk-commons), which is fully open source and free.

The agent imports the library as a dependency and uses it to execute commands:

| Component | Where it lives |
|---|---|
| All CDK constructs, builders, spec format, Step Functions primitives | Library (open source, free) |
| Command receiver, executor, status reporter | Agent (open source, free) |
| State, orchestration, dashboard, API, billing | Backend (open code, paid hosting) |

**Why everything stays in the library:**
- The library is the adoption engine. Teams discover it, write specs, deploy with `cdk deploy`. When they outgrow manual management, they already have specs in the format the service understands — zero migration cost.
- The agent is just the glue between the backend and the library. It receives a command ("synth this spec"), calls the library's builders, and reports back. No proprietary logic needed.
- The paid product is the backend (state, orchestration, dashboard), not the builders.

---

## Installation and setup

The customer deploys the agent into their AWS account:

1. **Sign up** on the lonic dashboard. Create a project and connect an AWS account.
2. **Deploy the agent** — the dashboard provides a one-click CloudFormation template (or CDK command) that creates the agent stack. The template includes:
   - The agent Lambda/Fargate task
   - An API Gateway endpoint (or SQS queue) for receiving commands
   - An IAM role with scoped permissions
   - A shared secret for authenticating commands from the backend
3. **Verify** — the backend sends a health check command to confirm connectivity.

The agent stack is lightweight and cheap to run (a few Lambda invocations per deployment, zero cost at idle if using Lambda).

---

## Security model

**Authentication:**
- Commands from the backend are signed with a shared secret established during setup.
- The agent verifies the signature before executing any command.
- The callback URL uses HTTPS with the backend's TLS certificate.

**Authorization:**
- The agent's IAM role is scoped to the minimum permissions needed for the operations it performs.
- The customer can further restrict the role (e.g. deny access to specific stacks, regions, or resources).
- The customer can revoke access entirely by deleting or disabling the IAM role.

**Data flow:**
- Source code: cloned within the customer's account (via CodeBuild or S3). Never sent to the backend.
- Secrets: stored in the customer's Secrets Manager / SSM Parameter Store. Never sent to the backend.
- CloudFormation templates: synthesised in the customer's account. The backend may receive stack names and outputs (not template bodies) for state tracking.
- Logs: streamed to the backend for dashboard display. Customers can opt out or filter sensitive log lines.

**Auditability:**
- Every API call the agent makes is logged in CloudTrail.
- The agent's code is open source — customers can audit it before deploying.
- The command format is documented — customers can inspect what the backend is asking the agent to do (via API Gateway access logs or SQS message inspection).

---

## Relationship to the backend

The agent is a subordinate of the backend. It does not make decisions — it executes instructions.

**The backend decides:**
- What to deploy and when (based on user actions, API calls, or trigger events).
- Rollout strategy (which tenants, what order, what concurrency).
- Whether to retry a failed command.
- What the current desired state is for each environment and tenant.

**The agent does:**
- Synth specs into CloudFormation templates.
- Deploy/destroy CloudFormation stacks.
- Report status and outputs back.
- Discover stack topology for bring-your-own CDK projects.

**The agent does NOT:**
- Store state (no database, no persistent config).
- Make deployment decisions (no scheduling, no rollout logic).
- Communicate with anything other than the backend and AWS APIs.
- Know about tenants, environments, or users — it just processes individual commands.

---

## Future considerations

- **Multi-region agents.** A customer may want agents in multiple AWS regions. Each agent is an independent stack that registers with the backend.
- **Multi-account agents.** For customers with AWS Organizations, agents in member accounts reporting to a single backend project.
- **Agent pooling.** For high-throughput scenarios (many concurrent tenant deployments), multiple agent instances behind a load balancer or consuming from a shared SQS queue.
- **Offline mode.** If the backend is unreachable, the agent queues status updates and flushes them when connectivity is restored.
