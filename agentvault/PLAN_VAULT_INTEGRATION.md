# AgentVault Vault Integration Plan
**Date:** February 11, 2026
**Priority:** High
**Est. Effort:** 3-5 days

---

## Executive Summary

Integrate HashiCorp-style vault functionality into AgentVault for secure credential management. This replaces insecure credential sharing (pasting keys, storing passwords in .env files) with a proper vault that supports:

- **Scoped access** — Least-privilege principle
- **Audit trails** — Track who accessed what and when
- **TTL/secrets** — Time-limited credentials that auto-expire
- **Injection prevention** — Secrets never exposed to agents or CLI processes
- **Version control** — Track changes to secrets, allow rollbacks

---

## Current State Assessment

### ✅ What's Already Built
- **CLI framework** (`cli/commands/`) — Ready for extension
- **Local state management** — `.agentvault/`, `agent.config.json`, `canister_ids.json`
- **Agent config parsing** — Robust YAML/JSON config loading
- **TypeScript interfaces** — Core types defined in `src/lib/types.ts`

### ❌ What's Missing
- **Vault client** — No integration with external vault service
- **Secrets storage** — Credentials hardcoded or stored in `.env` files
- **Vault-aware CLI commands** — Commands don't know about vault
- **Webapp vault integration** — Dashboard doesn't connect to vault
- **Audit logging** — No tracking of vault access events
- **Secret injection** — Secrets loaded directly without TTL or versioning

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    AgentVault CLI                             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Commands Layer                                │  │
│  │                                                 │  │
│  │  init   │  status   │  fetch   │  exec   │  │  │
│  │         │          │          │         │        │  │  │
│  └────────┬─────────┴──────────┬────────┘  │  │
│             │                          │               │          │  │  │
│             ▼                          ▼               ▼          │  │  │
│  ┌────────────────────────────────────────────────────┐  │  │
│  │              Vault Client (New)               │  │  │
│  │  - Connect to HashiCorp Vault                │  │  │
│  │  - Read/write secrets with scoping         │  │  │
│  │  - Audit trail for all operations             │  │  │
│  │  - TTL/expiration management                 │  │  │
│  │  - Version control for secrets              │  │  │
│  └────────────────┬─────────────────────────────┘  │  │
│                        │                         │          │  │
│                        ▼                         ▼          │  │  │
│  ┌─────────────────────────────────────────────────┐  │  │
│  │              Webapp (Dashboard)               │  │  │
│  │  - Optional: Connect to vault              │  │  │
│  │  - View vault secrets (read-only)            │  │  │
│  │  - Manage vault connection settings           │  │  │
│  │  - View audit logs                          │  │  │
│  └───────────────────────────────────────────────────┘  │  │
│                                                              │
│                         ┌────────────────────┐               │          │  │
│                         │  Agent Vault Repo │               │          │  │
│                         │                 │               │          │  │
│                         │                 │               │          │  │
└─────────────────────────┴───────────────────────────────────────┘          │  └────────┴────────────┘
                    └─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Vault Client Library (Day 1)

**Goal:** Create TypeScript client for HashiCorp Vault with full feature parity.

**File:** `src/lib/vault-client.ts`

**Features:**
1. **Connection Management**
   - Connect to vault (HTTPS with optional headers)
   - Health checks with retries
   - Graceful fallback when vault is unavailable

2. **Secret Operations**
   - `getSecret(path, version?)` — Read secret with versioning
   - `setSecret(path, value, options?)` — Write secret with TTL, metadata
   - `deleteSecret(path, version?)` — Delete secret, create new version
   - `listSecrets(path?)` — List all secrets with versions
   - `revokeSecret(path, version?)` — Immediately revoke secret

3. **Access Control**
   - `getPolicies()` — Retrieve access policies
   - `checkAccess(policy, resource)` — Check if user has access

4. **Audit Logging**
   - `getAuditLog(from?, to?)` — Retrieve audit trail
   - Local caching for offline operations

**Integration Points:**
- Extend `AgentConfig` to support `vaultUri?`
- Update `init()` command to prompt for vault connection
- Modify `deploy()` to optionally read wallet keys from vault

---

### Phase 2: CLI Command Extensions (Day 1)

**Goal:** Add vault-aware commands that use Vault Client.

**New Commands:**

1. **`cli/commands/vault.ts`** (New file)
   - `vault: connect <url>` — Connect to vault
   - `vault: status` — Show vault connection status
   - `vault: ls` — List secrets (with versions)
   - `vault: get <path>` — Get secret value
   - `vault: set <path> <value>` — Set secret
   - `vault: rm <path>` — Delete secret
   - `vault: refresh` — Reconnect/validate vault connection

2. **Update `cli/commands/init.ts`**
   - Prompt: "Connect to vault? (optional)"
   - Store `vaultUri` and `vaultToken` in `agent.config.json`

3. **Update existing commands**
   - `deploy()` — Read wallet keys from vault if available
   - `exec()` — Support `--vault` flag for secret injection
   - `fetch()` and `status()` — Show vault source for secrets

---

### Phase 3: Webapp Integration (Day 2)

**Goal:** Optional vault integration in dashboard.

**New Files:**

1. **`webapp/src/providers/VaultProvider.tsx`** (New provider)
   - Vault connection state
   - Methods: `connect()`, `disconnect()`, `isConnected()`, `getSecret()`

2. **`webapp/src/hooks/useVault.ts`** (New hook)
   - Consume VaultProvider across app
   - Handle vault unavailability gracefully

3. **`webapp/src/app/(dashboard)/settings/page.tsx`** (Update)
   - Add vault connection settings form:
     - Vault URL
     - Connection status indicator
     - Test connection button
     - Disconnect button

4. **`webapp/src/components/common/VaultStatus.tsx`** (New component)
   - Badge showing "Vault" or "Local" status

---

### Phase 4: Configuration & Migration (Day 2-3)

**Goal:** Existing user support and migration path.

**Migration Options:**

1. **Option A: Automatic Migration** (Recommended)
   - Detect existing `.agentvault/` config
   - Prompt: "Would you like to connect to HashiCorp Vault?"
   - Create vault connection with `vault: connect`
   - Migrate secrets to vault automatically

2. **Option B: Manual Setup** (For Control)
   - Add `VAULT_URI` and `VAULT_TOKEN` to `.agentvault/config.yaml`
   - User manually runs `agentvault vault: connect`
   - Explicit control over when vault is used

---

## Secret Schema (Local File Fallback)

If vault is unavailable, fall back to encrypted local storage:

**File:** `~/.agentvault/secrets.json`

**Schema:**
```json
{
  "$schema": "https://agentvault.com/schema/v1",
  "secrets": {
    "claude_api_key": {
      "value": "sk-...",
      "version": "v1",
      "created_at": "2026-02-11T...",
      "last_access": "2026-02-11T...",
      "metadata": {
        "purpose": "AI inference",
        "source": "user_provided"
      }
    },
    "wallet_private_key": {
      "value": "0x...",
      "version": "v1",
      "created_at": "2026-02-11T...",
      "metadata": {
        "chain": "ethereum",
        "purpose": "agent_wallet"
      }
    }
  },
  "$version": "v1"
}
```

**Features:**
- AES-256 encryption with PBKDF2
- Version history (up to 10 versions per secret)
- Last-access timestamps
- Purpose/metadata tagging
- Read/write via VaultClient (primary) or local fallback

---

## Security Considerations

### ✅ Benefits
- **No more pasting keys** — Secret exposure eliminated
- **Audit trails** — All vault operations logged
- **Scoped access** — Agents only access what they need
- **Revocation** — Compromised secrets can be revoked immediately
- **TTL policies** — Secrets auto-expire, reducing risk window

### ⚠️ Risks to Mitigate
- **Vault dependency** — If vault is down, agent operations fail
  - Mitigation: Local encrypted file fallback
  - Mitigation: Cache secrets in memory during vault connections
- **Token compromise** — If vault token stolen, attacker has access
  - Mitigation: Token rotation workflow (admin revokes, user generates new)
- **DoS attacks** — Vault rate limits could block legitimate agents
  - Mitigation: Exponential backoff, local caching

---

## Testing Strategy

### Unit Tests
```typescript
// tests/vault-client.test.ts
describe('Vault Client', () => {
  it('connects to vault', async () => {
    const client = new VaultClient('http://localhost:8200');
    await client.connect('test-token');
    expect(client.isConnected()).toBe(true);
  });

  it('handles vault unavailability', async () => {
    const client = new VaultClient('http://localhost:8200');
    await client.connect('test-token');
    expect(await client.getSecret('/test')).toEqual('test-value');
  });
});
```

### Integration Tests
```bash
# Test vault integration with CLI
agentvault deploy --vault-secret /claude_api_key
agentvault deploy --vault-secret /wallet_private_key
agentvault exec --agent-id abc123 --vault-secret /api_key
```

---

## Success Criteria

- [ ] Vault client library created with full feature parity
- [ ] CLI commands extended with vault operations
- [ ] Webapp vault provider added (optional integration)
- [ ] Vault connection settings in dashboard
- [ ] Migration guide for existing users
- [ ] Local encrypted secrets fallback implemented
- [ ] All tests passing (existing + new vault tests)
- [ ] Documentation updated

---

## Open Questions

1. **Vault service?** Should we self-host HashiCorp Vault, use HCP Vault, or integrate with existing vault service?

2. **Migration priority?** Should vault integration be opt-in (manual) or automatic for new users?

3. **Scope granularity?** How detailed should secret scoping be? (per-secret, per-app, per-user?)

4. **TTL defaults?** What should default secret expiration be? (1 hour, 24 hours, 7 days?)

---

## Next Steps

1. **Review and approve** this plan with user
2. **Create implementation branch:** `feature/vault-integration`
3. **Implement Phase 1** (Vault Client Library)
4. **Implement Phase 2** (CLI Commands)
5. **Implement Phase 3** (Webapp Integration)
6. **Test thoroughly** (unit + integration + migration)
7. **Merge to main** when ready

---

*This plan balances feature completeness with pragmatic implementation, considering both new users (need migration) and existing workflows (local fallback).*
