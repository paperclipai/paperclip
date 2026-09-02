# Codex identity-keyed host credential cache

This document describes the host credential cache for Codex authentication. The
cache keeps one usable subscription credential per identity (`account_id`) in a
separate host store. The cache is additive. It does not change the copy-back
path, the fail-closed decision predicate, or the host default store overwrite.

## Where the cache lives

The cache root is company-scoped, under the same isolation boundary as the
managed Codex home:

```
<instanceRoot>/companies/<companyId>/codex-auth-cache/<account_id>/auth.json
```

The root sits outside the shared Codex home (`resolveSharedCodexHomeDir`) and
outside the symlink allowlist. The `account_id` is sanitized to one safe path
segment. Each cache root and each identity directory is private (mode `0700`).

## The two directions

The board set one rule for both directions. A side that has no credential can
receive one, but only when a real credential on one side names the expected
identity. The harness never picks a credential from the cache at random.

- **Host to sandbox (inbound).** A sandbox that starts with no Codex credential
  takes the host credential. The cache does not change this. At provision the
  cache also refreshes the host credential with a strictly-newer cached copy of
  the same identity (the vend, below).
- **Sandbox to host (copy-back).** A host that already holds an identity keeps a
  strictly-newer same-identity credential from the sandbox. The cache does not
  change this. At teardown the cache also writes the sandbox credential into its
  per-identity slot (the cache write, below).

## The identity anchor rule

The identity anchor rule is the load-bearing constraint:

- The **cache vend** only refreshes an identity the host **already holds** in the
  shared home. It replaces the staged host credential with a strictly-newer
  cached credential of the **same** `account_id`. It never introduces a new
  identity.
- When the host shared home holds **no** credential, the vend does **nothing**.
  The harness never selects a cache entry to seed an empty host. This is the
  "no random pick from the cache when the host is empty" rule.
- The **cache write** keys each entry by the real `account_id` of the credential
  that flows back from the sandbox. It writes to a per-identity cache slot, never
  to the host default store. The cache write is best-effort: it runs after the
  host copy-back finishes, so a cache-write failure never replaces the successful
  copy-back result. The failure is logged with its errno code and the next
  teardown re-attempts the write.

The host never learns an identity from the cache. The host only refreshes an
identity a real credential already states.

## State matrix

"Host has auth" means the shared source store `resolveSharedCodexHomeDir(env)/auth.json`
holds a usable subscription credential. "Sandbox has auth" means the run's
sandbox `auth.json` holds a usable credential at teardown. `X` and `Y` are two
different subscription identities (`account_id`).

| # | Host store | Sandbox cred | Inbound: sandbox home gets | Copy-back: host store | Cache write | Cache vend | Identity anchor |
|---|---|---|---|---|---|---|---|
| 1a | HAS `X` | HAS `X`, newer | fresher of the two (`X`) | overwrite with newer `X` | write slot `X` | may stage a strictly-newer cached `X` | host and sandbox both name `X` |
| 1b | HAS `X` | HAS `Y` (`Y != X`) | host `X` (predicate rejects `Y`) | keep host `X` | write slot `Y` (per identity) | may stage a strictly-newer cached `X` | host names `X`; `Y` is cached, never adopted |
| 2 | HAS `X` | NONE | host `X` | keep host (sandbox absent) | no write (no source) | may stage a strictly-newer cached `X` | host names `X` |
| 3 | NONE | HAS `Y` | image-login fallback; host store **never seeded** | keep host **empty** (never seed) | write slot `Y` | **none** (host empty, no random pick) | sandbox names `Y`; host is silent |
| 4 | NONE | NONE | image-login fallback, or the run fails | keep host **empty** | no write | **none** | no side names an identity |

The cache changes an outcome only in the "stage a strictly-newer cached copy of
an identity the host already holds" cases (rows 1a, 1b, 2, vend column). It never
changes which identity a side uses. It never seeds an empty host store (rows 3,
4).

## Off-switch

The cache is on by default. Set the environment flag `PAPERCLIP_CODEX_AUTH_CACHE`
to an explicit falsy value (`0`, `false`, `no`, or `off`) to turn it off. When
off, the teardown cache write and the provision vend become no-ops. The host
default overwrite is unchanged in both states.

## Cache-clear action

Two operator actions remove cached credentials:

- `clearCodexAuthCacheEntry(env, accountId, companyId)` removes exactly one
  identity slot.
- `clearCodexAuthCache(env, companyId)` removes every slot in the company-scoped
  cache root.

To disable the cache without a code revert, use the off-switch. To remove a
single cached identity, use `clearCodexAuthCacheEntry`. To remove every cached
credential, delete the cache root or use `clearCodexAuthCache`. Neither action
affects the host default store.

## No secret in logs

The cache logs the decision and the outcome only. It never logs token bytes and
never logs a raw `account_id`.
