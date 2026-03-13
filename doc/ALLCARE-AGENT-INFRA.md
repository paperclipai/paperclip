# AllCare Agent Infrastructure

Architecture decisions, integration plan, and execution status for AllCare's AI agent infrastructure built on Paperclip + CXDB + StrongDM agentic-auth patterns.

**Owner:** Ramy Barsoum (CPO)
**Date:** 2026-03-12

## The Stack

| Layer | Tool | Purpose | Status |
|---|---|---|---|
| **Identity** (who) | Paperclip + DPoP | Agent registry, org chart, scopes, keypairs | Merged (PR #1) |
| **Memory** (what was said) | CXDB | Long-running conversation context, branching, dedup | Forked, integration decided |
| **Auth** (proof of who) | StrongDM agentic-auth patterns | DPoP (RFC 9449) cryptographic token binding | Grafted onto Paperclip |
| **Cost** (how much) | Paperclip built-in | Per-agent monthly budgets, auto-stop at limit | Ready |
| **Audit** (HIPAA trail) | Paperclip + HIPAA extensions | PHI access tracking, delegation chains, 6yr retention | Merged (PR #1) |
| **Dashboard** (HR portal) | Paperclip React UI | Org chart, cost view, audit view, governance | Ready |
| **Governance** (board control) | Paperclip built-in | Approval gates, agent termination, strategy overrides | Ready |

## Repos

| Repo | Purpose | URL |
|---|---|---|
| AllCare-ai/paperclip | Agent identity, cost, audit, governance, dashboard | https://github.com/AllCare-ai/paperclip |
| AllCare-ai/cxdb | Agent conversation memory (context store) | https://github.com/AllCare-ai/cxdb |
| strongdm/agentic-auth | DPoP auth pattern reference (not forked, reference only) | https://github.com/strongdm/agentic-auth |

Both repos have branch protection: no deletion, no force push, linear history required.

## Two Use Cases

### 1. Dark Factory / GSD Agents (Internal, Dev-Time)

Agents running GSD and Dark Factory framework in Claude Code for Level 2 and Level 3 development tracks.

- Each agent gets identity for audit trail
- Track which agent wrote what code, made what decisions
- Cost tracking across parallel factory runs
- Scope enforcement prevents executor agents from exceeding authorized capabilities

### 2. AI Concierge Agents (Production, Patient-Facing)

Agents handling task routing, classification, escalation, and patient communication.

- Every action tied to specific agent identity for HIPAA audit logging
- Agent-to-agent auth for capability handoffs
- Clean identity boundary at human escalation points
- Long-running patient conversation memory (weeks/months) via CXDB
- Content deduplication across patient interactions

## Architecture Decisions

### Decision 1: Paperclip as Agent Control Plane

**Chose:** Fork Paperclip, graft StrongDM DPoP patterns.
**Over:** Building from scratch, Azure AD service principals, SaaS vendors.
**Why:** Paperclip gives 80% of what we need (registry, cost, audit, governance, dashboard). DPoP adds the cryptographic identity layer. Self-hosted, no SaaS dependency.

### Decision 2: CXDB as Context Store

**Chose:** Fork CXDB for agent conversation memory.
**Over:** Postgres JSON blobs, custom context service, no context store.
**Why:** The Concierge UI uses continuous chat (Notion-style). Patient conversations span weeks/months. CXDB's Turn DAG with O(1) branching and content-addressed dedup handles this without degradation.

### Decision 3: CXDB Integration via HTTP Gateway

**Chose:** Option 1. Python/LangGraph agents call CXDB's Go gateway over HTTP/JSON.
**Over:** Option 2 (custom Python client for binary protocol), Option 3 (Go sidecar microservice).
**Why:** The Rust server has full read+write HTTP API. The Go gateway proxies all /v1/* routes including writes. POST /v1/contexts/:id/append confirmed at ~2ms write latency. No new client library needed. A thin Python wrapper around httpx is sufficient.

### Decision 4: Standalone Azure Microservices

**Chose:** Both Paperclip and CXDB deploy as independent Azure-hosted microservices.
**Over:** Embedding in allcare-platform, running on Supabase.
**Why:** AllCare is microservices architecture (separate repos, separate deploys). Both services serve multiple consumers (Dark Factory + AI Concierge). Independent lifecycle matters.

### Decision 5: Azure AD at Perimeter, DPoP Inside

**Chose:** Human users auth via Azure AD. Agents auth via DPoP-bound JWTs.
**Over:** Azure AD for everything, StrongDM SaaS.
**Why:** Azure AD is our existing identity provider for staff. Agents need cryptographic proof-of-possession that Azure AD doesn't natively support. Two layers: Azure AD gets you into the system, DPoP proves which agent did what inside the system.

## What Was Built (PR #1, Merged 2026-03-12)

532 insertions across 11 files on Paperclip:

**New files:**
- `server/src/dpop.ts` - DPoP proof verification (RFC 9449), ES256 keypair generation, JWK thumbprint
- `server/src/middleware/scope-enforcement.ts` - Scope validation, narrowing for child agents, PHI level detection

**Schema extensions:**
- `agents` table: +scopes, maxScopeDepth, phiAccessLevel, publicKeyJwk, parentAgentId, dpopEnabled
- `activity_log` table: +phiAccessed, patientId, accessJustification, delegationChain, retentionPolicy, dpopJkt

**Auth upgrades:**
- `agent-auth-jwt.ts`: DPoP-bound token creation + verification, cnf/scopes claims. Backward compatible.
- `middleware/auth.ts`: DPoP proof verification in JWT path, agent_dpop source type.
- `types/express.d.ts`: Actor extended with scopes, dpopJkt.

**Route + service updates:**
- Agent creation: scope narrowing enforcement + keypair generation when dpopEnabled=true
- Activity routes: HIPAA fields in create schema, phiOnly/patientId query filters
- Activity service: HIPAA fields in logActivity helper + list query filters

## Execution Plan

### Phase 1: Build Concierge Agents (NOW, not blocked)

Build LangGraph agent nodes against interfaces. Wire to Paperclip/CXDB later.

- Agent logic (classification, routing, escalation) is independent of identity/memory infrastructure
- Code against simple interfaces: `log_action()`, `store_turn()`, `get_context()`
- Mock implementations for local development
- Mohab leads engineering

### Phase 2: Infrastructure Setup (parallel, non-blocking)

Can happen while Concierge agents are being built.

- Swap CXDB gateway auth from Google OAuth to Azure AD
- Swap Paperclip dashboard auth to Azure AD via better-auth OIDC config
- Define AllCare turn types for CXDB: ai.allcare.PatientMessage, ai.allcare.ToolCall, ai.allcare.ToolResponse, ai.allcare.Escalation, ai.allcare.TaskResolution
- Docker Compose for local dev (Paperclip + CXDB + Postgres)

### Phase 3: Azure Deployment (when ready for integration testing)

- Paperclip: Azure Container App + Azure Database for PostgreSQL
- CXDB: Azure Container App + Azure Blob/File storage for Turn DAG
- Environment configuration, secrets management
- Health checks, monitoring

### Phase 4: Integration (wire agents to infrastructure)

- Replace mock interfaces with real Paperclip/CXDB calls
- Each LangGraph node logs actions to Paperclip with HIPAA fields
- Each agent interaction writes turns to CXDB
- Concierge UI reads conversation context from CXDB gateway
- End-to-end testing: agent creates context, appends turns, UI displays, audit log captures PHI access

## CXDB API Reference (for Concierge Integration)

All endpoints via Go gateway at port 8080, proxied to Rust server.

```
POST   /v1/contexts/create          Create patient conversation context
POST   /v1/contexts/fork            Branch from existing turn (patient callback)
POST   /v1/contexts/:id/append      Append turn (message, tool call, escalation)
GET    /v1/contexts/:id/turns       Read turns (with typed projection)
GET    /v1/contexts                 List all contexts
GET    /v1/contexts/:id             Get context details
GET    /v1/events                   SSE stream for real-time turn updates
PUT    /v1/registry/bundles/:id     Register AllCare turn types
```

### AllCare Turn Types (To Be Registered)

| Type ID | Purpose | PHI? |
|---|---|---|
| ai.allcare.PatientMessage | Inbound patient message (SMS, call, portal) | Yes |
| ai.allcare.AgentResponse | Outbound agent response to patient | Yes |
| ai.allcare.ToolCall | Agent invokes a capability (patient lookup, classification) | Depends |
| ai.allcare.ToolResponse | Result of tool invocation | Depends |
| ai.allcare.Escalation | Agent escalates to human operator | Yes |
| ai.allcare.TaskResolution | Task completed, outcome recorded | Yes |
| ai.allcare.InternalNote | Agent-to-agent context (not visible to patient) | Maybe |

## StrongDM Use Cases Applied to AllCare

| # | Use Case | AllCare Application |
|---|---|---|
| 1 | Agent proves identity | Concierge capabilities authenticating during handoffs |
| 2 | User delegation | Concierge acting on behalf of ops user or patient |
| 3 | Constrained capabilities | Classifier can't write prescriptions |
| 4 | Spawn with narrowed permissions | Dark Factory executor spawns sub-agents with limited scope |
| 5 | Audit trail | HIPAA audit log. Which agent did what, when, with whose permission. |
| 6 | Legacy OAuth access | Concierge agents calling existing .NET APIs via Azure AD |
| 7 | Cross-vendor collaboration | Agents calling OpenAI, Anthropic, Azure with unified identity |
| 8 | Organizational identity | Multi-tenant. Different clinics get isolated agent realms. |
