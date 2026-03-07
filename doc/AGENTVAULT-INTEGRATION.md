# AgentVault Integration — Implementation Guide

Status: Implemented on branch `claude/integrate-agentvault-hxPgm`
Date: 2026-03-07
Audience: AgentVault and Paperclip maintainers

## 1. Overview

AgentVault is integrated as a first-party workspace package in Paperclip, serving as the memory/knowledge/truth/consensus/communication backbone of the autonomous org control plane. The integration bridges AgentVault's HashiCorp Vault client into Paperclip's existing secret provider system and adds four new subsystems on top.

### What changed

| Layer | Files | Purpose |
|---|---|---|
| Workspace | `pnpm-workspace.yaml`, `server/package.json`, `agentvault/package.json` | AgentVault added as `workspace:*` dependency with `./vault` subpath export |
| Secrets | `server/src/secrets/vault-provider.ts` | Real Vault provider replacing the stub |
| Memory | `packages/db/.../agent_memory.ts`, `server/src/services/memory.ts`, `server/src/routes/memory.ts` | Per-agent key-value working memory |
| Knowledge | `packages/db/.../knowledge_entries.ts`, `server/src/services/knowledge.ts`, `server/src/routes/knowledge.ts` | Company-scoped shared knowledge base |
| Communication | `packages/db/.../agent_messages.ts`, `server/src/services/communication.ts`, `server/src/routes/messages.ts` | Agent-to-agent messaging |
| Consensus | `packages/db/.../consensus_proposals.ts`, `server/src/services/consensus.ts`, `server/src/routes/consensus.ts` | Proposal and voting mechanism |
| Vault health | `server/src/services/vault.ts`, `server/src/routes/vault.ts` | Backbone health endpoint |
| Shared types | `packages/shared/src/types/backbone.ts`, `packages/shared/src/validators/backbone.ts`, `packages/shared/src/constants.ts` | Types, validators, constants for all subsystems |
| Docker | `docker-compose.yml`, `docker-compose.quickstart.yml` | HashiCorp Vault service added |
| DB migration | `packages/db/src/migrations/0026_wealthy_reavers.sql` | Schema for 5 new tables |

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Paperclip Server                         │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐   │
│  │  Memory   │ │Knowledge │ │ Messages │ │  Consensus    │   │
│  │ Service   │ │ Service  │ │ Service  │ │  Service      │   │
│  └────┬──┬──┘ └────┬─────┘ └────┬─────┘ └────┬──────────┘   │
│       │  │         │            │             │              │
│       │  │    ┌────┴────────────┴─────────────┘              │
│       │  │    │                                               │
│       │  ▼    ▼                                               │
│       │  PostgreSQL (agent_memory, knowledge_entries,         │
│       │   agent_messages, consensus_proposals, consensus_votes)│
│       │                                                       │
│       ▼                                                       │
│  ┌─────────────────────┐                                      │
│  │ Vault Provider      │──── vault-provider.ts                │
│  │ (SecretProviderModule)│                                    │
│  └────────┬────────────┘                                      │
│           │ imports                                            │
│           ▼                                                    │
│  ┌─────────────────────┐                                      │
│  │ agentvault/vault    │──── VaultClient, loadVaultConfig     │
│  │ (workspace package) │                                      │
│  └────────┬────────────┘                                      │
│           │ HTTP                                               │
│           ▼                                                    │
│  ┌─────────────────────┐                                      │
│  │ HashiCorp Vault     │──── KV-v2 secrets engine             │
│  │ (Docker container)  │                                      │
│  └─────────────────────┘                                      │
└──────────────────────────────────────────────────────────────┘
```

## 3. How the Vault provider bridge works

Paperclip's secret system uses a `SecretProviderModule` interface with two methods:

- `createVersion({ value, externalRef })` → `{ material, valueSha256, externalRef }`
- `resolveVersion({ material, externalRef })` → `string`

The bridge in `server/src/secrets/vault-provider.ts`:

1. **On create**: Calls `VaultClient.putSecret()` to store the value in Vault. Saves the Vault path and version number in `material` (as `vault_v1` scheme). Returns a SHA-256 hash of the value and the Vault path as `externalRef`.

2. **On resolve**: Reads `vaultPath` and `vaultKey` from the stored `material`, creates a `VaultClient` scoped to that path, and calls `getSecret()` to retrieve the value.

3. **Configuration**: Reads `VAULT_ADDR` and `VAULT_TOKEN` from environment variables via AgentVault's `loadVaultConfig()`. Falls back gracefully — if Vault is not configured, operations throw `422 Unprocessable` (same as the old stub behavior).

### Key import

```typescript
import { VaultClient, loadVaultConfig, validateVaultConfig } from "agentvault/vault";
```

This uses the `./vault` subpath export added to `agentvault/package.json`:

```json
"exports": {
  ".": { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" },
  "./vault": { "types": "./dist/src/vault/index.d.ts", "import": "./dist/src/vault/index.js" }
}
```

## 4. Subsystem details

### 4.1 Agent Memory

**Table**: `agent_memory`
**Columns**: id, companyId, agentId, key, value, metadata (jsonb), vaultRef, ttlSeconds, expiresAt, createdAt, updatedAt
**Unique constraint**: (agentId, key)

**API endpoints**:
| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/companies/:cid/agents/:aid/memory` | agent (own) or board | List all memory entries |
| GET | `/api/companies/:cid/agents/:aid/memory/:key` | agent (own) or board | Get single entry |
| PUT | `/api/companies/:cid/agents/:aid/memory` | agent (own only) or board | Upsert entry |
| DELETE | `/api/companies/:cid/agents/:aid/memory/:key` | agent (own only) or board | Delete entry |

**PUT body** (`setMemorySchema`):
```json
{ "key": "context.last_task", "value": "Reviewed PR #42", "metadata": {}, "ttlSeconds": 3600 }
```

**Design notes**:
- Agents can only write/delete their own memory; board can read all.
- TTL is optional — when set, `expiresAt` is computed at write time. The `purgeExpired()` service method can be called periodically.
- `vaultRef` is reserved for future use where sensitive memory values are stored in Vault instead of the DB.

### 4.2 Knowledge Base

**Table**: `knowledge_entries`
**Status lifecycle**: `draft` → `proposed` → `ratified` → `archived`

**API endpoints**:
| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/companies/:cid/knowledge?category=&status=&search=` | company member | List with filters |
| GET | `/api/knowledge/:id` | company member | Get single entry |
| POST | `/api/companies/:cid/knowledge` | agent or board | Create entry |
| PATCH | `/api/knowledge/:id` | agent or board | Update entry |
| DELETE | `/api/knowledge/:id` | agent or board | Delete entry |

**POST body** (`createKnowledgeEntrySchema`):
```json
{
  "title": "API Design Guidelines",
  "content": "All new endpoints must...",
  "category": "policy",
  "status": "draft"
}
```

**Design notes**:
- Categories: `general`, `architecture`, `policy`, `decision`, `process`, `reference`
- Entries are versioned (auto-incremented on each update).
- When a consensus proposal passes with a linked `knowledgeEntryId`, the entry is automatically ratified.

### 4.3 Agent Communication

**Table**: `agent_messages`

**API endpoints**:
| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/api/companies/:cid/messages` | agent only | Send a message |
| GET | `/api/companies/:cid/messages/channel/:name` | company member | List channel messages |
| GET | `/api/companies/:cid/agents/:aid/messages/inbox` | company member | Agent inbox |
| GET | `/api/companies/:cid/agents/:aid/messages/sent` | company member | Agent sent messages |
| GET | `/api/messages/:id/thread` | company member | Get message thread |
| POST | `/api/messages/:id/acknowledge` | company member | Acknowledge receipt |

**POST body** (`sendMessageSchema`):
```json
{
  "toAgentId": "uuid-of-recipient",
  "messageType": "request",
  "subject": "Code review needed",
  "body": "Please review the auth module changes",
  "priority": "high"
}
```

For broadcast messages, omit `toAgentId` and set `channel`:
```json
{
  "channel": "engineering",
  "messageType": "notification",
  "body": "Deployment complete"
}
```

**Design notes**:
- Only agents can send messages (enforced by the route).
- Messages support threading via `parentMessageId`.
- Messages can reference other entities (issues, tasks) via `referenceType` and `referenceId`.
- Priority levels: `low`, `normal`, `high`, `urgent`.

### 4.4 Consensus

**Tables**: `consensus_proposals`, `consensus_votes`
**Proposal lifecycle**: `draft` → `open` → `passed` | `rejected` | `vetoed` | `expired`

**API endpoints**:
| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/companies/:cid/proposals?status=` | company member | List proposals |
| GET | `/api/proposals/:id` | company member | Get proposal |
| POST | `/api/companies/:cid/proposals` | agent or board | Create proposal |
| POST | `/api/proposals/:id/vote` | agent or board | Cast vote |
| POST | `/api/proposals/:id/veto` | board only | Board veto |
| GET | `/api/proposals/:id/votes` | company member | List votes |

**Create proposal body** (`createProposalSchema`):
```json
{
  "title": "Adopt TypeScript strict mode",
  "description": "Proposal to enable strict TypeScript checking...",
  "proposalType": "policy",
  "quorumType": "majority",
  "knowledgeEntryId": "uuid-of-knowledge-entry",
  "expiresAt": "2026-03-14T00:00:00Z"
}
```

**Cast vote body** (`castVoteSchema`):
```json
{ "vote": "for", "reasoning": "Strict mode catches bugs early" }
```

**Quorum resolution logic**:
- **majority**: votesFor > votesAgainst
- **supermajority**: votesFor >= 2/3 of total votes
- **unanimous**: zero against votes, at least one for vote
- **board_approval**: majority, but board can veto independently

When quorum is reached, the proposal auto-resolves. If the proposal has a linked `knowledgeEntryId` and passes, the knowledge entry is automatically ratified.

**Board veto**: POST `/api/proposals/:id/veto` immediately sets status to `vetoed`. Board-only.

### 4.5 Vault Health

**API endpoint**:
| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/vault/health` | any | Backbone health check |

**Response**:
```json
{
  "configured": true,
  "healthy": true,
  "vaultAddress": "http://vault:8200",
  "vaultVersion": "1.17.0",
  "message": "Vault backbone is healthy"
}
```

Returns 200 when healthy or unconfigured, 503 when configured but unhealthy.

## 5. Local development setup

### With Docker Compose (recommended)

```bash
# Start Vault + Postgres + Server
docker compose up -d

# Vault is available at http://localhost:8200
# Paperclip API at http://localhost:3100
# Dev token: paperclip-dev-token
```

### Without Docker (dev mode)

```bash
# Start Vault separately
cd agentvault && docker compose up -d
# This starts Vault at http://localhost:8200 with token: agentvault-dev-token

# Set env vars for Paperclip
export VAULT_ADDR=http://localhost:8200
export VAULT_TOKEN=agentvault-dev-token

# Start Paperclip
pnpm dev
```

### Verify the integration

```bash
# Check Vault backbone health
curl http://localhost:3100/api/vault/health

# Create a secret using the Vault provider
curl -X POST http://localhost:3100/api/companies/<ID>/secrets \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-vault","provider":"vault","value":"secret123"}'
```

## 6. Database migration

Migration `0026_wealthy_reavers.sql` creates 5 new tables:

- `agent_memory` — per-agent key-value working memory
- `knowledge_entries` — company-scoped knowledge base
- `agent_messages` — agent-to-agent messaging
- `consensus_proposals` — decision proposals
- `consensus_votes` — votes on proposals

The migration runs automatically on server startup (Drizzle auto-migration).

## 7. Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_ADDR` | No | — | HashiCorp Vault server URL |
| `VAULT_TOKEN` | No | — | Vault authentication token |
| `VAULT_NAMESPACE` | No | — | Vault namespace (enterprise) |
| `VAULT_ROLE_ID` | No | — | AppRole role ID (alternative to token auth) |
| `VAULT_SECRET_ID` | No | — | AppRole secret ID |
| `VAULT_CACERT` | No | — | TLS CA certificate path |
| `VAULT_SKIP_VERIFY` | No | `false` | Skip TLS verification |

When `VAULT_ADDR` is not set, the Vault provider is inactive and attempts to use `provider: "vault"` will return 422. The existing `local_encrypted` provider remains the default.

## 8. AgentVault package changes

The following changes were made to the `agentvault` package:

1. **`package.json`**: Added `./vault` subpath export so the server can import `agentvault/vault` directly:
   ```json
   "exports": {
     ".": { ... },
     "./vault": { "types": "./dist/src/vault/index.d.ts", "import": "./dist/src/vault/index.js" }
   }
   ```

2. **Build requirement**: The `agentvault` package must be built (`pnpm --filter agentvault build`) before the server can typecheck. This happens automatically during `pnpm -r build` or `pnpm build`.

No source code changes were made to AgentVault itself — the integration consumes the existing `VaultClient`, `loadVaultConfig`, `validateVaultConfig`, and type exports as-is.

## 9. Shared package additions

### Constants (`packages/shared/src/constants.ts`)

```typescript
KNOWLEDGE_STATUSES  // "draft" | "proposed" | "ratified" | "archived"
KNOWLEDGE_CATEGORIES // "general" | "architecture" | "policy" | "decision" | "process" | "reference"
MESSAGE_TYPES       // "text" | "request" | "response" | "notification" | "decision"
MESSAGE_PRIORITIES  // "low" | "normal" | "high" | "urgent"
PROPOSAL_TYPES      // "strategy" | "knowledge" | "policy" | "action" | "resource"
PROPOSAL_STATUSES   // "draft" | "open" | "passed" | "rejected" | "vetoed" | "expired"
QUORUM_TYPES        // "majority" | "supermajority" | "unanimous" | "board_approval"
VOTE_VALUES         // "for" | "against" | "abstain"
```

### Types (`packages/shared/src/types/backbone.ts`)

`AgentMemoryEntry`, `KnowledgeEntry`, `AgentMessage`, `ConsensusProposal`, `ConsensusVote`

### Validators (`packages/shared/src/validators/backbone.ts`)

`setMemorySchema`, `createKnowledgeEntrySchema`, `updateKnowledgeEntrySchema`, `sendMessageSchema`, `acknowledgeMessageSchema`, `createProposalSchema`, `castVoteSchema`

### API paths (`packages/shared/src/api.ts`)

```typescript
API.memory    // "/api/memory"
API.knowledge // "/api/knowledge"
API.messages  // "/api/messages"
API.consensus // "/api/consensus"
API.vault     // "/api/vault"
```

## 10. Future work

- **Vault-backed memory**: Store sensitive agent memory values in Vault instead of the DB (the `vaultRef` column is already present).
- **Knowledge embeddings**: Add vector similarity search for knowledge entries.
- **Message subscriptions**: WebSocket-based real-time message delivery to agents.
- **Consensus automation**: Scheduled proposal expiry and automatic quorum checking.
- **On-chain anchoring**: Use AgentVault's ICP canister to anchor knowledge hashes and consensus outcomes on-chain for immutable audit trails.
- **Multi-backend secrets**: Support Bitwarden via AgentVault's `BitwardenProvider` as an alternative to HashiCorp Vault.
