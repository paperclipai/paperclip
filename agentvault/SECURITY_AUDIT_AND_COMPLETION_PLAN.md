# AgentVault Security Audit & Feature Completion Plan

**Date:** February 21, 2026
**Auditors:** Kilo (Security) & Codex (Code Review)
**Slack Thread:** https://clem-f3w8808.slack.com/archives/C0AGR2RNEL9/p1771689347292369

---

## Executive Summary

This document consolidates findings from a thorough security audit and code review of the AgentVault codebase, comparing implementation status against design specifications. The audit identified **27 security findings** and **12 incomplete features** that should be addressed before production release.

### Current State Summary

| Category | Status |
|----------|--------|
| TypeScript Compilation | ✅ Passes (after `npm install --legacy-peer-deps`) |
| Test Suite | ⚠️ 619/628 tests pass (9 failures in 4 files) |
| npm Audit | ⚠️ 9 vulnerabilities (2 moderate, 7 high) |
| ESLint | ⚠️ Missing @eslint/js dependency |
| Security Findings | 27 total (1 critical, 4 high, 13 medium, 9 low) |

---

## Part 1: Security Findings

### CRITICAL (Must Fix Immediately)

#### SEC-1: Command Injection in Tool Detection
- **File:** `src/icp/tool-detector.ts:23,38`
- **Issue:** Uses `execaCommand()` with string interpolation
```typescript
const whichResult = await execaCommand(`which ${name}`, {...})
const versionResult = await execaCommand(`${name} --version`, {...})
```
- **Risk:** If `name` becomes user-controlled, allows arbitrary command execution
- **Fix:** Use array-based arguments: `execa('which', [name], {...})`

### HIGH (Fix Before Release)

#### SEC-2: TLS Certificate Not Actually Used
- **Files:** `src/vault/client.ts:215-238`, `src/vault/config.ts:84-86`
- **Issue:** `caCertPath` is loaded but never passed to `fetch()`, making TLS verification ineffective
- **Risk:** MITM attacks possible even with `tlsSkipVerify: false`
- **Fix:** Implement proper TLS certificate handling with `undici` or `https` agent

#### SEC-3: Seed Phrase Retained in Memory
- **File:** `src/security/vetkeys.ts:59-70, 311-336`
- **Issue:** Seed phrase included in returned key objects
- **Risk:** Memory dumps can expose seed phrases
- **Fix:** Clear seed phrase from memory after key derivation using `Buffer.fill(0)`

#### SEC-4: Dynamic Function() Code Execution
- **Files:** `src/inference/bittensor-client.ts:94-97`, `src/archival/arweave-client.ts:83-86`
- **Issue:** Uses `new Function()` for dynamic imports
```typescript
const dynamicImport = new Function('modulePath', 'return import(modulePath)');
```
- **Risk:** Bypasses CSP, code smell for security audits
- **Fix:** Replace with standard ESM dynamic imports: `await import('axios')`

#### SEC-5: Secrets Exposed via CLI Arguments
- **File:** `cli/commands/wallet.ts:42, 59-62`
- **Issue:** `--mnemonic`, `--private-key`, `--password` accepted as CLI options
- **Risk:** Visible in process list (`ps aux`) and shell history
- **Fix:** Read from stdin, environment variables, or interactive prompts only

### MEDIUM (Address Soon)

| ID | File | Issue | Fix |
|----|------|-------|-----|
| SEC-6 | `src/vault/client.ts:308-331` | Regex ReDoS in pattern validation | Use pre-compiled patterns |
| SEC-7 | `src/security/vetkeys.ts:225` | `Math.random()` for share IDs | Use `crypto.randomBytes()` |
| SEC-8 | `src/wallet/providers/solana-provider.ts:409-410` | Address logged to console | Remove debug logging |
| SEC-9 | `src/security/vetkeys.ts:452` | Secret IDs logged | Use debug flag guard |
| SEC-10 | `src/wallet/key-derivation.ts:176-205` | IV used as PBKDF2 salt | Generate separate salt |
| SEC-11 | `src/deployment/icpClient.ts:323-328` | Weak canister ID validation | Use `Principal.fromText()` |
| SEC-12 | `src/wallet/wallet-storage.ts:39-45` | No path traversal validation | Add `sanitizePathPart()` |
| SEC-13 | `src/security/multisig.ts:168-170` | Non-cryptographic audit tokens | Document limitation clearly |
| SEC-14 | `src/vault/client.ts` | No rate limiting on API calls | Add exponential backoff |
| SEC-15 | `src/packaging/wasmedge-compiler.ts:34,228` | Debug mode default true | Default to false |
| SEC-16 | `src/wallet/types.ts:23-46` | Unencrypted wallet storage | Encrypt at rest |
| SEC-17 | `src/backup/backup.ts` | Non-atomic file writes | Use temp file + rename |

### LOW (Consider Fixing)

| ID | File | Issue |
|----|------|-------|
| SEC-18 | `src/canister/actor.ts:302-309` | Anonymous agent for local dev (expected) |
| SEC-19 | `.gitignore:55` | Backups directory handling |
| SEC-20 | Multiple files | Environment variable secrets (documented) |
| SEC-21 | `src/wallet/wallet-storage.ts:27-62` | Predictable storage paths |
| SEC-22 | External APIs | No client-side rate limiting |
| SEC-23 | `src/canister/actor.ts:303` | HTTP for local development (expected) |
| SEC-24 | Dependencies | `axios`, `arweave` optional deps |
| SEC-25-27 | Various | File permission considerations |

---

## Part 2: Dependency Vulnerabilities

### npm audit findings (9 vulnerabilities)

| Package | Severity | Issue | Fix |
|---------|----------|-------|-----|
| `ajv` | Moderate | ReDoS with `$data` option | `npm audit fix` |
| `bn.js` | Moderate | Infinite loop | `npm audit fix` |
| `minimatch` | High | ReDoS via repeated wildcards | `npm audit fix` |
| `@typescript-eslint/*` | High | Depends on vulnerable minimatch | Update typescript-eslint |

### Recommended Action
```bash
npm audit fix
# Update ESLint ecosystem to resolve dependency conflicts
npm install eslint@^9.0.0 typescript-eslint@latest @eslint/js@latest --save-dev
```

---

## Part 3: Test Failures

### Current Status: 619/628 tests pass (4 failing files)

| Test File | Failures | Issue |
|-----------|----------|-------|
| `tests/e2e/pipeline.test.ts` | 1 | `HttpAgent` mock not a constructor |
| `tests/unit/encryption.test.ts` | 1 | Timing-safe comparison assertion flaky |
| `tests/wallet/chains.test.ts` | 3 | Test timeout (5s too short) |
| `tests/integration/*.test.ts` | 4 | Various mock/integration issues |

### Fixes Required

1. **E2E Pipeline Test:** Fix `HttpAgent` mock to be a proper constructor
2. **Encryption Test:** Increase timing tolerance or use different measurement approach
3. **Wallet Tests:** Increase timeout to 15000ms for chain operations

---

## Part 4: Incomplete Features (per Design Specs)

### From PRD & Phase Documentation

| Feature | Status | Files | Action Needed |
|---------|--------|-------|---------------|
| Backup includes real canister state | ⚠️ Partial | `src/backup/backup.ts:66-117` | Fetch and include canister state |
| Promotion triggers deployment | ⚠️ Partial | `src/deployment/promotion.ts:97-127` | Wire to `deployAgent()` |
| E2E integration test | ❌ Missing | `tests/e2e/` | Create full pipeline test |
| Encryption unit tests | ❌ Missing | `tests/unit/` | Add verifyHMAC tests |
| Monitoring unit tests | ❌ Missing | `tests/unit/` | Add parseCycleValue tests |
| Experimental features marked | ❌ Missing | CLI commands | Add [Experimental] prefix |
| README updated | ⚠️ Partial | `README.md` | Update with actual capabilities |
| CHANGELOG v1.0.0 entry | ⚠️ Partial | `CHANGELOG.md` | Add final release notes |
| True Shamir Secret Sharing | ⚠️ Stub | `src/security/vetkeys.ts` | Document as placeholder |
| VetKeys canister integration | ⚠️ Stub | `src/security/vetkeys.ts` | Document as simulated |

---

## Part 5: Implementation Plan

### Phase 1: Critical Security Fixes (Immediate)

1. **Fix command injection in tool-detector.ts**
   - Replace string interpolation with array arguments
   - Whitelist allowed tool names

2. **Fix TLS certificate validation**
   - Use `undici` or custom `https.Agent` with CA cert
   - Add tests for TLS behavior

3. **Remove seed phrase from returned objects**
   - Clear memory after key derivation
   - Add `seedBuffer.fill(0)` cleanup

4. **Replace `new Function()` with standard imports**
   - Use `await import('axios')` directly
   - Remove dynamic import wrapper functions

### Phase 2: High Priority Fixes

5. **Fix CLI secret exposure**
   - Remove `--mnemonic`, `--private-key`, `--password` options
   - Add interactive prompts via `inquirer`

6. **Fix `Math.random()` usage**
   - Replace with `crypto.randomBytes().toString('hex')`

7. **Add path traversal validation**
   - Create `sanitizePathPart()` utility
   - Apply to all user-provided path components

8. **Fix dependency vulnerabilities**
   - Run `npm audit fix`
   - Update ESLint ecosystem

### Phase 3: Test Fixes

9. **Fix E2E pipeline test**
   - Create proper HttpAgent mock factory

10. **Fix encryption timing test**
    - Increase tolerance or use statistical approach

11. **Fix wallet chain tests**
    - Increase timeout to 15000ms

### Phase 4: Feature Completion

12. **Complete backup functionality**
    - Fetch actual canister state before backup

13. **Complete promotion functionality**
    - Wire promotion to deployAgent()

14. **Add missing unit tests**
    - Encryption timing tests
    - Monitoring parseCycleValue tests
    - Health threshold tests

### Phase 5: Documentation

15. **Update README.md**
    - Accurate CLI command reference
    - Installation instructions
    - Quick start guide

16. **Update CHANGELOG.md**
    - v1.0.0 release notes

17. **Mark experimental features**
    - Add [Experimental] to CLI help for: inference, archive, profile, trace

---

## Part 6: File-Level Changes Required

### Critical Changes

| File | Line(s) | Change |
|------|---------|--------|
| `src/icp/tool-detector.ts` | 23, 38 | Use array args for execa |
| `src/vault/client.ts` | 215-238 | Implement TLS cert handling |
| `src/security/vetkeys.ts` | 311-336 | Remove seedPhrase from return |
| `src/security/vetkeys.ts` | 225 | Use crypto.randomBytes() |
| `src/inference/bittensor-client.ts` | 94-97 | Use standard import() |
| `src/archival/arweave-client.ts` | 83-86 | Use standard import() |

### High Priority Changes

| File | Line(s) | Change |
|------|---------|--------|
| `cli/commands/wallet.ts` | 42, 59-62 | Remove secret CLI options |
| `src/wallet/wallet-storage.ts` | 39-45 | Add path validation |
| `src/deployment/icpClient.ts` | 323-328 | Use Principal.fromText() |
| `src/wallet/providers/solana-provider.ts` | 409-410 | Remove console.log |
| `src/packaging/wasmedge-compiler.ts` | 34, 228 | Default debug to false |

### Test Fixes

| File | Change |
|------|--------|
| `tests/e2e/pipeline.test.ts` | Fix HttpAgent mock |
| `tests/unit/encryption.test.ts` | Fix timing assertion |
| `tests/wallet/chains.test.ts` | Increase timeout |

---

## Acceptance Criteria

Before v1.0.0 release, the following must be true:

- [ ] All CRITICAL and HIGH security issues resolved
- [ ] `npm audit` shows 0 high/critical vulnerabilities
- [ ] All 628 tests pass
- [ ] TypeScript compiles with 0 errors
- [ ] ESLint passes with 0 errors
- [ ] README accurately reflects capabilities
- [ ] CHANGELOG has v1.0.0 entry
- [ ] Experimental features clearly marked

---

## Timeline Estimate

| Phase | Scope | Estimate |
|-------|-------|----------|
| Phase 1 | Critical Security | 2-3 hours |
| Phase 2 | High Priority | 2-3 hours |
| Phase 3 | Test Fixes | 1-2 hours |
| Phase 4 | Feature Completion | 3-4 hours |
| Phase 5 | Documentation | 2-3 hours |
| **Total** | | **10-15 hours** |

---

## Appendix: Code Snippets for Key Fixes

### A. Command Injection Fix (tool-detector.ts)

```typescript
// Before (vulnerable)
const whichResult = await execaCommand(`which ${name}`, {...})

// After (safe)
import { execa } from 'execa';
const ALLOWED_TOOLS = ['dfx', 'moc', 'wasmedge', 'wasm-opt', 'node'];
if (!ALLOWED_TOOLS.includes(name)) {
  throw new Error(`Unknown tool: ${name}`);
}
const whichResult = await execa('which', [name], {...});
```

### B. Seed Phrase Cleanup (vetkeys.ts)

```typescript
// Before
return {
  type: 'threshold',
  key: derivedKey.key,
  seedPhrase,  // EXPOSED!
};

// After
const seedBuffer = Buffer.from(seedPhrase, 'utf8');
try {
  const key = deriveFromSeed(seedBuffer);
  return { type: 'threshold', key };
} finally {
  seedBuffer.fill(0);  // Clear from memory
}
```

### C. Path Validation Utility

```typescript
// src/utils/path-validation.ts
export function sanitizePathPart(part: string): string {
  if (!part ||
      part.includes('..') ||
      part.includes('/') ||
      part.includes('\\') ||
      part.includes('\0')) {
    throw new Error('Invalid path component');
  }
  return part;
}
```

### D. Dynamic Import Fix

```typescript
// Before (code smell)
const dynamicImport = new Function('modulePath', 'return import(modulePath)');
const axiosModule = await dynamicImport('axios');

// After (standard)
const axiosModule = await import('axios');
```

---

**End of Security Audit & Completion Plan**
