# Lonic Cloud Backend — Design Documentation

This directory contains the complete design documentation for the Lonic Cloud backend service. The backend is the control plane for Lonic Cloud — it manages apps, infrastructure, pipelines, deployments, and communicates with agents deployed in customer AWS accounts.

## Documents

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | High-level architecture, stack decomposition, repo structure, technology choices |
| [Domain Model](domain-model.md) | Entity relationships, DynamoDB table design, access patterns |
| [Authentication & Authorization](auth.md) | SSO flow, session cookies, API keys, agent tokens, license checks |
| [Agent Communication Protocol](agent-protocol.md) | Complete API reference for backend-to-agent and agent-to-backend communication |
| [Backend API Design](api-design.md) | REST API endpoints exposed by the backend to the frontend and programmatic consumers |
| [Deployment Orchestration](orchestration.md) | How the backend orchestrates deployments across agents, approval gates, rollbacks |

## Key Architectural Decisions

- **Monorepo**: CDK infrastructure and Rust Lambda code live in the same repository
- **Rust + ARM64 Lambdas**: All business logic in Rust for performance and type safety
- **DynamoDB**: Primary database — multi-table design with GSIs for access patterns
- **Angular SPA**: Frontend hosted on S3 + CloudFront, no SSR
- **Fine-grained CDK stacks**: ~13 stacks split by resource type and domain for surgical deployments
- **Agent as dumb executor**: All orchestration intelligence lives in the backend; the agent only executes individual commands
