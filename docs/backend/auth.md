# Authentication & Authorization

## Three Authentication Paths

The backend serves three types of consumers, each with its own authentication mechanism:

| Consumer | Auth Method | Credential | Lifetime |
|----------|-----------|------------|----------|
| Web UI (Angular SPA) | HTTP-only secure session cookie | Session token | Hours (configurable) |
| Programmatic API | API key in header | `X-Api-Key: <key>` | Long-lived, manually revoked |
| Agent callbacks | Bearer token in header | `Authorization: Bearer <token>` | Permanent (issued at registration) |

## 1. Web UI Authentication (SSO)

### Flow

```
┌──────────┐     ┌──────────────┐     ┌──────────────────┐
│  Angular  │     │  Lonic SSO   │     │  Lonic Cloud     │
│  SPA      │     │  Service     │     │  Backend         │
└─────┬─────┘     └──────┬───────┘     └────────┬─────────┘
      │                  │                      │
      │  1. User clicks  │                      │
      │     "Sign In"    │                      │
      │─────────────────►│                      │
      │                  │                      │
      │  2. SSO login    │                      │
      │     (SSO UI)     │                      │
      │◄─────────────────│                      │
      │                  │                      │
      │  3. Redirect to  │                      │
      │     lonic cloud  │                      │
      │     with ?code=  │                      │
      │◄─────────────────│                      │
      │                  │                      │
      │  4. POST /auth/callback                 │
      │     { code }     │                      │
      │─────────────────────────────────────────►│
      │                  │                      │
      │                  │  5. POST /sso/verify  │
      │                  │     { code }          │
      │                  │◄──────────────────────│
      │                  │                      │
      │                  │  6. { userGid,        │
      │                  │     email, name }     │
      │                  │─────────────────────►│
      │                  │                      │
      │  7. Set-Cookie:  │                      │
      │     session=<token>;                    │
      │     HttpOnly; Secure;                   │
      │     SameSite=Strict                     │
      │◄────────────────────────────────────────│
      │                  │                      │
      │  8. Subsequent   │                      │
      │     API calls    │                      │
      │     with cookie  │                      │
      │─────────────────────────────────────────►│
```

### Step-by-Step

1. User clicks "Sign In" in the Angular SPA
2. SPA redirects to Lonic SSO service login page
3. After successful SSO login, SSO redirects back to Lonic Cloud with `?code=<auth_code>` in the URL
4. SPA sends `POST /auth/callback` with the auth code
5. Backend calls SSO verification endpoint to validate the code
6. SSO returns user details: `{ userGid, email, displayName }`
7. Backend creates a session, stores it in DynamoDB (`lonic-auth` table), and sets an HTTP-only secure cookie
8. All subsequent requests include the session cookie automatically

### SSO Verification Request

```
POST <SSO_BASE_URL>/verify
Content-Type: application/json

{
  "code": "<auth_code_from_redirect>"
}
```

### SSO Verification Response

```json
{
  "valid": true,
  "user": {
    "gid": "user_abc123",
    "email": "user@example.com",
    "displayName": "Jane Doe"
  }
}
```

### Session Cookie Properties

| Property | Value | Rationale |
|----------|-------|-----------|
| `HttpOnly` | `true` | Prevents JavaScript access (XSS protection) |
| `Secure` | `true` | HTTPS only |
| `SameSite` | `Strict` | CSRF protection |
| `Path` | `/` | Available to all API routes |
| `Max-Age` | Configurable (e.g., 8 hours) | Session duration |
| `Domain` | `.lonic.dev` (or similar) | Shared across subdomains |

### Session Storage (DynamoDB)

```
Table: lonic-auth
PK: SESSION#<token>
SK: META

{
  "userGid": "user_abc123",
  "orgId": "org_xyz",
  "email": "user@example.com",
  "displayName": "Jane Doe",
  "createdAt": "2024-01-01T12:00:00Z",
  "expiresAt": 1704110400  (TTL — auto-deleted)
}
```

### Logout

```
POST /auth/logout
Cookie: session=<token>
```

- Deletes the session from DynamoDB
- Clears the cookie in the response

## 2. Programmatic API Authentication (API Keys)

### Key Format

API keys are generated as cryptographically random strings. The backend stores a **SHA-256 hash** of the key — the plaintext is shown to the user exactly once at creation time.

### Usage

```
GET /api/v1/apps
X-Api-Key: lonic_key_abc123def456...
```

### Key Properties

| Property | Description |
|----------|------------|
| `orgId` | Organization the key belongs to |
| `wsId` | Optional workspace scope (null = all workspaces) |
| `name` | Human-readable label |
| `permissions` | Scoped permissions (e.g., `read:apps`, `write:deployments`) |
| `createdAt` | Creation timestamp |
| `lastUsedAt` | Updated on each use |
| `expiresAt` | Optional expiry |

### Key Storage (DynamoDB)

```
Table: lonic-auth
PK: APIKEY#<sha256_hash>
SK: META

{
  "orgId": "org_xyz",
  "wsId": "ws_abc",        // null for org-wide
  "name": "CI/CD Pipeline",
  "permissions": ["read:apps", "write:deployments", "read:agents"],
  "createdAt": "2024-01-01T12:00:00Z",
  "lastUsedAt": "2024-01-15T08:30:00Z",
  "expiresAt": null
}
```

### Key Management Endpoints

```
POST   /api/v1/api-keys          # Create key (returns plaintext once)
GET    /api/v1/api-keys          # List keys (metadata only, no plaintext)
DELETE /api/v1/api-keys/<keyId>  # Revoke key
```

## 3. Agent Authentication (Bearer Token)

### Registration Flow

When an agent stack is deployed, the registration custom resource calls the backend:

```
POST <CALLBACK_BASE_URL>/agent/register
Content-Type: application/json

{
  "agentId": "<agent_id>",
  "setupToken": "<single_use_setup_token>",
  "agentVersion": "0.1.0"
}
```

The backend validates the `setupToken` and returns a permanent bearer token:

```json
{
  "callbackToken": "<bearer_token>"
}
```

The agent stores this token in AWS Secrets Manager and uses it for all callbacks.

### Agent Callback Authentication

All agent-to-backend communication uses this token:

```
POST <CALLBACK_BASE_URL>/agent/callback
Authorization: Bearer <callbackToken>
Content-Type: application/json
```

### Token Lifecycle

| Event | Action |
|-------|--------|
| Agent stack deployed | Setup token exchanged for callback token |
| Agent stack updated | Registration Lambda re-runs, may refresh token |
| Agent stack deleted | Deregistration call, backend invalidates token |
| Token compromised | Backend can revoke token, agent re-registers on next update |

## Authorization Model

### Request Flow

```
Request
  ├── Cookie present? → Validate session → Extract userGid, orgId
  ├── X-Api-Key present? → Hash key, lookup → Extract orgId, permissions
  └── Authorization: Bearer present? → Validate agent token → Extract agentId

  Then:
  ├── Check org license (active, not expired, within limits)
  ├── Check user role in target workspace (if user auth)
  ├── Check API key permissions (if API key auth)
  └── Check resource ownership (resource belongs to the org/workspace)
```

### Permission Matrix

| Action | Owner | Admin | Member | Viewer | API Key (scoped) |
|--------|-------|-------|--------|--------|------------------|
| View apps/instances | Y | Y | Y | Y | `read:apps` |
| Create/edit apps | Y | Y | Y | - | `write:apps` |
| Delete apps | Y | Y | - | - | `delete:apps` |
| Trigger deployment | Y | Y | Y | - | `write:deployments` |
| Approve deployment | Y | Y | Y* | - | `write:approvals` |
| Manage agents | Y | Y | - | - | `write:agents` |
| Manage members | Y | Y | - | - | `write:members` |
| Manage workspace | Y | Y | - | - | `write:workspaces` |
| Manage billing | Y | - | - | - | - |
| Delete org | Y | - | - | - | - |

*Members can approve only if listed as an approver in the pipeline step.

## License Checks

### License Storage

```
Table: lonic-auth
PK: ORG#<orgId>
SK: LICENSE

{
  "plan": "team",
  "maxWorkspaces": 5,
  "maxAgents": 10,
  "maxAppsPerWorkspace": 50,
  "maxInstancesPerApp": 20,
  "deploymentRetentionDays": 365,
  "features": ["visual_builder", "templates", "auto_deploy", "approvals"],
  "expiresAt": "2025-12-31T23:59:59Z"
}
```

### Plans

| Feature | Personal (Free) | Team | Enterprise |
|---------|----------------|------|-----------|
| Workspaces | 1 | 5 | Unlimited |
| Agents | 1 | 10 | Unlimited |
| Apps per workspace | 5 | 50 | Unlimited |
| Instances per app | 3 | 20 | Unlimited |
| Visual builder | - | Y | Y |
| Templates | Basic | All | All + custom |
| Auto-deploy (git) | - | Y | Y |
| Manual approvals | - | Y | Y |
| Deployment retention | 7 days | 1 year | Custom |
| Support | Community | Email | Dedicated |

### Enforcement Points

License checks happen at:
1. **Resource creation** — creating an app, instance, workspace, or agent registration
2. **Feature gating** — accessing visual builder, templates, approval gates
3. **Login** — check license not expired, show upgrade prompts
