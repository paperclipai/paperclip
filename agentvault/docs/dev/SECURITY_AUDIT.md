# AgentVault Security Audit Report

**Version:** v1.0.0  
**Date:** February 12, 2026  
**Scope:** Internal security review of AgentVault codebase

---

## Executive Summary

This security audit identified **23 findings** across 7 security domains. The codebase demonstrates generally good security practices with strong encryption implementations, but has several areas requiring attention.

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 0 | No critical vulnerabilities |
| High | 2 | Require immediate attention |
| Medium | 9 | Should be addressed soon |
| Low | 8 | Consider fixing |
| Info | 4 | Positive findings / documentation |

**Overall Assessment:** AgentVault is suitable for v1.0 release with documented limitations. High-severity findings should be addressed in v1.1.

---

## Methodology

This audit reviewed:

- **100+ TypeScript files** (~15,000 lines of code)
- All CLI command handlers
- Core library modules (deployment, wallet, security, canister)
- External integrations (Bittensor, Arweave, multi-chain wallets)
- Dependencies in package.json

Security domains covered:
1. Authentication & Authorization
2. Cryptographic Operations
3. Secrets Management
4. Input Validation
5. Network Security
6. File Operations
7. Dependencies

---

## 1. Authentication & Authorization

### Finding 1.1: No Hardcoded Credentials Found

**Severity:** Informational (Positive)  
**Files:** Various test files

No hardcoded production credentials found. Test files use clearly fake values like `0xabcdef1234...`.

**Recommendation:** Continue this practice; consider adding automated scanning for credential leaks.

---

### Finding 1.2: Local Approval System Lacks Cryptographic Verification

**Severity:** Medium  
**File:** `src/security/multisig.ts:47-58`

The multisig approval system uses `auditToken` which is described as "NOT a cryptographic signature":

```typescript
export interface ApprovalSignature {
  signer: string;
  /** Audit token - NOT a cryptographic signature */
  auditToken: string;
  timestamp: Date;
  comment?: string;
}
```

**Risk:** Token is just a SHA-256 hash that can be forged by anyone who knows request parameters.

**Mitigation:** Documentation clearly states this is for audit trail only.

**Recommendation:** For production multisig, use VetKeys canister-based threshold signatures.

---

### Finding 1.3: Anonymous Agent for Local Development

**Severity:** Low  
**File:** `src/canister/actor.ts:302-309`

`createAnonymousAgent` creates an unauthenticated agent for local development:

```typescript
export function createAnonymousAgent(host?: string): HttpAgent {
  const defaultHost = process.env.ICP_LOCAL_URL || 'http://localhost:4943';
  return new HttpAgent({ host: host ?? defaultHost });
}
```

**Risk:** Could be accidentally used in production.

**Mitigation:** Only used for local development; mainnet requires authenticated agent.

**Recommendation:** Add environment check to prevent production use.

---

## 2. Cryptographic Operations

### Finding 2.1: Strong Encryption Implementation

**Severity:** Informational (Positive)  
**File:** `src/canister/encryption.ts`

Encryption module implements AES-256-GCM and ChaCha20-Poly1305 with proper:
- Random IV generation (12 bytes for GCM)
- Authentication tags
- Timing-safe HMAC comparison
- PBKDF2 key derivation with 100,000 iterations

**Assessment:** Implementation follows best practices.

---

### Finding 2.2: Seed Phrase Retained in Memory

**Severity:** High  
**File:** `src/security/vetkeys.ts:59-70, 311-336`

Seed phrases are passed directly to key derivation and stored in returned objects:

```typescript
return {
  type: 'threshold',
  key: derivedKey.key,
  method: derivedKey.method,
  seedPhrase,  // <-- Seed phrase included in return object!
  ...
};
```

**Risk:** Seed phrases persist in memory longer than necessary, increasing exposure to memory dumps.

**Recommendation:**
1. Clear seed phrase from memory after key derivation
2. Never return seed phrase in derived key object
3. Use `Buffer.fill(0)` to zero memory

```typescript
// Recommended fix
const seedBuffer = Buffer.from(seedPhrase, 'utf8');
// ... derive key ...
seedBuffer.fill(0); // Clear from memory
```

---

### Finding 2.3: Weak Secret Sharing Implementation

**Severity:** Medium  
**File:** `src/security/vetkeys.ts:180-220`

Secret sharing is not true Shamir's Secret Sharing:

```typescript
private generateParticipantSecret(seedPhrase: string, participantIndex: number): string {
  const secretBytes = Buffer.from(seedPhrase, 'utf8');
  const participantSuffix = Buffer.concat([Buffer.from([participantIndex]), secretBytes]);
  return participantSuffix.toString('hex');
}
```

**Risk:** Shares are derived, not cryptographically split. Any single share can derive others.

**Mitigation:** Documentation notes this is not production-ready VetKeys.

**Recommendation:** Use proper SSS library like `shamir-secret-sharing` or integrate actual VetKeys canister.

---

### Finding 2.4: Encryption Key Not Persisted

**Severity:** Medium  
**File:** `src/wallet/vetkeys-adapter.ts:71-111`

`encryptSecret` generates a random key but returns only encrypted data:

```typescript
async encryptSecret(secret: string, transactionId?: string): Promise<EncryptedSecret> {
  const key = crypto.randomBytes(32);  // Key generated
  // ... encryption ...
  return { id, ciphertext, iv, tag, createdAt };  // Key not returned!
}
```

**Risk:** Data is unrecoverable without external key management.

**Recommendation:** Document key management requirements or return encrypted key.

---

## 3. Secrets Management

### Finding 3.1: Environment Variable Usage

**Severity:** Low  
**Files:** Multiple

API keys and RPC URLs read from environment variables:
- `ETHEREUM_RPC_URL`, `INFURA_API_KEY`, `ETHERSCAN_API_KEY`
- `SOLANA_RPC_URL`, `POLKADOT_RPC_URL`
- `ICP_LOCAL_URL`, `ICP_MAINNET_URL`

**Mitigation:** `.gitignore` includes `.env*` files.

**Recommendation:** Document required environment variables; consider secrets manager for production.

---

### Finding 3.2: Private Keys in WalletData Object

**Severity:** Medium  
**File:** `src/wallet/types.ts:23-46`

`WalletData` stores sensitive fields:

```typescript
export interface WalletData {
  privateKey?: string;  // Sensitive!
  mnemonic?: string;    // Sensitive!
  ...
}
```

**Risk:** Wallet data serialized to CBOR and stored locally unencrypted.

**Recommendation:** Encrypt sensitive fields at rest with user-provided password.

---

### Finding 3.3: Wallet Storage Path Predictability

**Severity:** Low  
**File:** `src/wallet/wallet-storage.ts:27-62`

Wallet files stored at predictable paths: `~/.agentvault/wallets/{agentId}/{walletId}.wallet`

**Mitigation:** Directory permissions default to user-only.

**Recommendation:** Ensure `~/.agentvault` has restrictive permissions (0700).

---

### Finding 3.4: Console Logging of Secret IDs

**Severity:** Medium  
**File:** `src/security/vetkeys.ts:452, 459, 497`

Debug logging includes secret-related IDs:

```typescript
console.log('Encrypted secret stored on canister:', secretId);
console.warn(`Failed to store encrypted secret on canister: ${message}`);
```

**Risk:** Information leakage in production logs.

**Recommendation:** Guard with debug flag or remove.

---

## 4. Input Validation

### Finding 4.1: Limited Canister ID Validation

**Severity:** Medium  
**File:** `src/deployment/icpClient.ts:323-328`

Canister ID validation uses regex instead of proper Principal parsing:

```typescript
const principalPattern = /^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/;
if (!principalPattern.test(canisterId)) {
  throw new Error(`Invalid canister ID format: ${canisterId}`);
}
```

**Recommendation:** Use `@dfinity/principal` `Principal.fromText()` for proper validation.

---

### Finding 4.2: No Agent ID Path Validation

**Severity:** Medium  
**File:** `src/wallet/wallet-storage.ts:39-45`

`agentId` used directly in file paths:

```typescript
export function getAgentWalletDir(agentId: string): string {
  return path.join(baseDir, agentId);  // No validation!
}
```

**Risk:** Path traversal if agentId contains `..` or `/`.

**Recommendation:**

```typescript
function sanitizePathPart(part: string): string {
  if (part.includes('..') || part.includes('/') || part.includes('\\')) {
    throw new Error('Invalid path component');
  }
  return part;
}
```

---

### Finding 4.3: Limited Backup Validation

**Severity:** Low  
**File:** `cli/commands/wallet-import.ts:100-114`

Backup validation checks structure but not content validity.

**Recommendation:** Add validation for wallet address formats, private key lengths.

---

### Finding 4.4: Proper Agent Name Validation

**Severity:** Informational (Positive)  
**File:** `cli/commands/init.ts:42-50`

Agent names properly validated:

```typescript
if (!/^[a-z0-9-]+$/.test(input)) {
  return 'Agent name must be lowercase alphanumeric with hyphens only';
}
```

**Assessment:** Good pattern to apply to other inputs.

---

## 5. Network Security

### Finding 5.1: Dynamic Code Execution for Module Loading

**Severity:** High  
**Files:** `src/inference/bittensor-client.ts:92-104`, `src/archival/arweave-client.ts:81-93`

Uses `new Function()` to dynamically import modules:

```typescript
private async importAxios(): Promise<any> {
  const dynamicImport = new Function('modulePath', 'return import(modulePath)');
  const axiosModule = await dynamicImport('axios');
```

**Risk:** Dynamic code execution pattern, though module path is hardcoded.

**Recommendation:** Replace with standard ESM dynamic imports:

```typescript
const axiosModule = await import('axios');
```

---

### Finding 5.2: External API Calls Without Rate Limiting

**Severity:** Low  
**File:** `src/wallet/providers/cketh-provider.ts:240-290`

Etherscan API calls have no client-side rate limiting.

**Recommendation:** Implement rate limiting for external APIs.

---

### Finding 5.3: HTTP for Local Development

**Severity:** Low  
**File:** `src/canister/actor.ts:303`

Local development uses HTTP:

```typescript
const defaultHost = process.env.ICP_LOCAL_URL || 'http://localhost:4943';
```

**Mitigation:** Only for local development.

**Recommendation:** Document that HTTP should never be used for production.

---

### Finding 5.4: Shell Command Execution

**Severity:** Medium  
**File:** `src/deployment/icpClient.ts:108-155`

Shell commands executed via `execa` with user-influenced parameters:

```typescript
await execa('dfx', ['canister', 'create', '--all', '--network', this.config.network]);
```

**Mitigation:** Uses execa which escapes arguments properly.

**Recommendation:** Validate `network` parameter against whitelist.

---

## 6. File Operations

### Finding 6.1: Path Traversal Risk in Multiple Locations

**Severity:** Medium  
**Files:** Multiple

Multiple functions use `path.join()` with user-provided identifiers:

| File | Function | Parameter |
|------|----------|-----------|
| `src/wallet/wallet-storage.ts` | `getAgentWalletDir()` | agentId |
| `src/security/multisig.ts` | `getApprovalFilePath()` | id |
| `src/backup/backup.ts` | `createBackup()` | agentName |
| `src/metrics/metrics.ts` | `getMetricsFilePath()` | canisterId |

**Recommendation:** Add validation for all path inputs (see Finding 4.2).

---

### Finding 6.2: Non-Atomic File Writes

**Severity:** Low  
**File:** `src/wallet/wallet-storage.ts:101`

Wallet files written without atomic operations:

```typescript
fs.writeFileSync(walletPath, Buffer.from(serialized));
```

**Risk:** Data corruption if process interrupted during write.

**Recommendation:** Use atomic writes:

```typescript
const tempPath = `${walletPath}.tmp`;
fs.writeFileSync(tempPath, Buffer.from(serialized));
fs.renameSync(tempPath, walletPath);
```

---

### Finding 6.3: Backup File Permissions

**Severity:** Low  
**File:** `src/backup/backup.ts:15-16`

Backups stored in `~/.agentvault/backups/` which may be world-readable.

**Recommendation:** Explicitly set directory permissions to 0700.

---

## 7. Dependencies

### Finding 7.1: Dependencies Current

**Severity:** Informational (Positive)  
**File:** `package.json`

Key dependencies are current:

| Package | Version | Status |
|---------|---------|--------|
| @dfinity/agent | ^3.4.3 | Current |
| ethers | ^6.16.0 | Current |
| @solana/web3.js | ^1.98.4 | Current |
| @polkadot/api | ^16.5.4 | Current |
| bip39 | ^3.1.0 | Current |

**Assessment:** No vulnerable dependency patterns detected.

---

### Finding 7.2: Optional Dependencies

**Severity:** Low  
**Files:** `src/inference/bittensor-client.ts`, `src/archival/arweave-client.ts`

`axios` and `arweave` are optional dependencies loaded dynamically.

**Mitigation:** Graceful error handling when not installed.

**Recommendation:** Document optional dependencies in README.

---

## Summary Table

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| 1.1 | Info | No hardcoded credentials | OK |
| 1.2 | Medium | Non-cryptographic multisig | Documented |
| 1.3 | Low | Anonymous local agent | Expected |
| 2.1 | Info | Strong encryption | OK |
| 2.2 | High | Seed phrase in memory | Needs Fix |
| 2.3 | Medium | Weak SSS implementation | Documented |
| 2.4 | Medium | Lost encryption key | Needs Doc |
| 3.1 | Low | Env var usage | OK |
| 3.2 | Medium | Unencrypted wallet storage | Needs Review |
| 3.3 | Low | Predictable storage path | OK |
| 3.4 | Medium | Debug logging of secrets | Needs Fix |
| 4.1 | Medium | Weak canister ID validation | Needs Fix |
| 4.2 | Medium | No agent ID validation | Needs Fix |
| 4.3 | Low | Limited backup validation | OK |
| 4.4 | Info | Good agent name validation | OK |
| 5.1 | High | Dynamic Function execution | Needs Fix |
| 5.2 | Low | No rate limiting | OK |
| 5.3 | Low | HTTP for local dev | Expected |
| 5.4 | Medium | Shell command execution | Review |
| 6.1 | Medium | Path traversal risk | Needs Fix |
| 6.2 | Low | Non-atomic writes | OK |
| 6.3 | Low | Backup permissions | Review |
| 7.1 | Info | Dependencies current | OK |
| 7.2 | Low | Optional deps handling | OK |

---

## Priority Recommendations

### Critical (Fix Immediately)

1. **Finding 2.2**: Remove seed phrase from returned objects in VetKeys
2. **Finding 5.1**: Replace `new Function()` with standard ESM imports

### High Priority (Fix in v1.1)

3. **Finding 6.1/4.2**: Add path validation for all user-provided identifiers
4. **Finding 3.4**: Remove debug logging of secret-related information
5. **Finding 4.1**: Use proper Principal validation for canister IDs

### Medium Priority (Plan to Fix)

6. **Finding 3.2**: Encrypt wallet data at rest with user password
7. **Finding 2.4**: Document key management for VetKeys adapter
8. **Finding 2.3**: Implement true Shamir's Secret Sharing or use proper library
9. **Finding 5.4**: Validate shell command parameters before execution

### Low Priority (Consider)

10. Set explicit file permissions on sensitive directories
11. Implement atomic file writes for critical data
12. Add rate limiting to external API calls

---

## Appendix: Quick Fix Examples

### Path Validation Helper

```typescript
export function sanitizePathPart(part: string): string {
  if (!part || part.includes('..') || part.includes('/') || part.includes('\\') || part.includes('\0')) {
    throw new Error('Invalid path component');
  }
  return part;
}
```

### Principal Validation

```typescript
import { Principal } from '@dfinity/principal';

export function validateCanisterId(canisterId: string): Principal {
  try {
    return Principal.fromText(canisterId);
  } catch {
    throw new Error(`Invalid canister ID: ${canisterId}`);
  }
}
```

### Memory-Safe Seed Handling

```typescript
function deriveKey(seedPhrase: string): DerivedKey {
  const seedBuffer = Buffer.from(seedPhrase, 'utf8');
  try {
    const key = deriveFromSeed(seedBuffer);
    return { key, method: 'pbkdf2' };
  } finally {
    seedBuffer.fill(0); // Always clear
  }
}
```

---

**Report Generated:** February 12, 2026  
**Auditor:** Internal Security Review  
**Next Review:** Recommended after v1.1 release
