# 2026-10-12 Git credential proof ownership map

The Git credential owner now holds all 14 existing redaction input/output assertions. The workspace suite no longer repeats that direct helper contract through a compatibility re-export. Runtime workspace code already imports the canonical helper directly, so the obsolete heartbeat import/re-export shim can be removed.

Parent: public PR #16079 at `2e17a5ed43ecb0002f7f0e2fe5c1017f35d7ffab`. Branch: `codex/test-audit-r13-git-credentials`.

## Scope and retained contract

| Item | Before | After |
|---|---:|---:|
| Direct redaction input/output assertions | 14 | 14 |
| Direct redaction helper calls | 14 | 14 |
| Registered keeper/workspace cases | 206 | 201 |
| Test source lines in the changed files | 3,705 | 3,687 |
| Obsolete heartbeat shim source lines | 6 | 0 |

The net reduction is 18 test source lines and six production shim lines. This is proof ownership and seam cleanup. It does not remove helper execution or establish a CI time reduction.

Removed workspace declarations at parent lines 949–986 preserve their complete bodies inside the four existing keeper declarations at `server/src/__tests__/git-credentials.test.ts:282`. Their five wrappers and the heartbeat import are removed. The six-line import/comment/re-export block at `server/src/services/heartbeat.ts:323–328` is the only production change.

All original input/output pairs were compared as a multiset after resolving the local string constants. Both sides contain exactly 14 pairs and have this canonical SHA-256: `78ff3b460616782e2380217c22ba00dbe757203a9e34d1c38d1ea294a4c5a9e0`.

## Assertion relocation map

| Original file and assertion line | Candidate keeper assertion line | Protected case |
|---|---:|---|
| git-credentials.test.ts:284 | 284 | HTTPS userinfo |
| git-credentials.test.ts:290 | 296 | SSH userinfo |
| git-credentials.test.ts:293 | 299 | scp-style remote remains unchanged |
| git-credentials.test.ts:299 | 311 | URL query with token and reference |
| git-credentials.test.ts:302 | 314 | arbitrary query parameter name |
| git-credentials.test.ts:308 | 326 | credential-free error text |
| heartbeat-workspace-session.test.ts:951 | 287 | quoted HTTPS userinfo in a Git error |
| heartbeat-workspace-session.test.ts:957 | 290 | bare username and multiple URLs |
| heartbeat-workspace-session.test.ts:963 | 302 | SSH and git+ssh userinfo in one error |
| heartbeat-workspace-session.test.ts:966 | 305 | scp-style remote with surrounding text |
| heartbeat-workspace-session.test.ts:972 | 317 | quoted query in a Git error |
| heartbeat-workspace-session.test.ts:975 | 320 | query with trailing error text |
| heartbeat-workspace-session.test.ts:982 | 328 | credential-free URL error |
| heartbeat-workspace-session.test.ts:984 | 330 | plain text with no URL |

## Scoped declaration ledger

| Parent declaration | Mark | Keeper and retained contract |
|---|---|---|
| git-credentials.test.ts:283 — masks URL userinfo | R | Keeps HTTPS userinfo and absorbs quoted errors, bare usernames, and multiple URLs. |
| git-credentials.test.ts:289 — non-HTTP userinfo and scp remotes | R | Keeps SSH/scp cases and absorbs git+ssh and surrounding-message cases. |
| git-credentials.test.ts:298 — complete query masking | R | Keeps arbitrary query keys and absorbs quote/trailing-message boundaries. |
| git-credentials.test.ts:307 — credential-free text | R | Keeps plain errors and absorbs credential-free URL/text examples. |
| heartbeat-workspace-session.test.ts:950 — URL userinfo | C | Move its unchanged assertion into the existing userinfo keeper. |
| heartbeat-workspace-session.test.ts:956 — bare usernames and multiple URLs | C | Move its unchanged assertion into the existing userinfo keeper. |
| heartbeat-workspace-session.test.ts:962 — non-HTTP userinfo and scp remotes | C | Move both unchanged assertions into the non-HTTP keeper. |
| heartbeat-workspace-session.test.ts:971 — complete query masking | C | Move both unchanged assertions into the query keeper. |
| heartbeat-workspace-session.test.ts:980 — credential-free text | C | Move both unchanged assertions and their local constants into the plain-text keeper. |
| heartbeat.ts:323–328 — scrubber re-export shim | D | No runtime importer remains through heartbeat. Workspace code uses the canonical Git credential owner. |

Other keeper and workspace declarations stay unchanged. This is a scoped ledger, not a claim that all 206 cases were deletion candidates.

## Production callers and history

The only production callers are in `server/src/services/heartbeat/workspaces.ts`: import at line 47 and calls at lines 602, 3545, and 3553. These callers already import `scrubGitCredentialText` from `git-credentials.ts`; their code stays unchanged. Repository search found no other heartbeat re-export consumer after the workspace test import was removed.

#10719 introduced the workspace redaction proof. #10720 established the Git credential owner. #10722 removed a duplicate implementation and retained the heartbeat re-export so older imports, including the workspace tests, still worked. The canonical implementation and its production callers now remain; the obsolete test-only import path is removed.

## Exact-parent verification

| Phase | Result |
|---|---|
| Keeper/workspace baseline | 206/206 passed |
| Candidate | 201/201 passed |
| Production owner mutation | 24 passed; two intended keeper failures |
| Production owner restored byte for byte | 201/201 passed |
| Real managed-checkout caller sibling | 19/19 passed |

Mutation: change the userinfo mask regex from `/gi` to `/i` in `server/src/services/git-credentials.ts:111`. The helper leaks credentials in later URLs. The keeper fails in the two migrated multi-URL assertions at candidate lines 290 and 302, whose assertions finish at lines 292 and 304. The production helper was restored to its exact parent bytes before the final replay.

Run from `server/`:

```sh
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/git-credentials.test.ts src/__tests__/heartbeat-workspace-session.test.ts
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/heartbeat-managed-clone-credentials.test.ts
```

Repo-wide typecheck, the full Vitest suite, and build were not run locally for this narrow owner consolidation. Draft PR checks must pass before a merge-ready handoff.

## Source hashes

| File | Parent SHA-256 | Candidate SHA-256 |
|---|---|---|
| server/src/__tests__/git-credentials.test.ts | `e236377145742b8074be8d61ff11b50812815436c5d188133f95475cd731384d` | `29e12200d45e8a17098bcc8571d82fc2ea3f68422b7cc04271a79b52b4f32ae0` |
| server/src/__tests__/heartbeat-workspace-session.test.ts | `ad26f3a88c25da94502889fd3f0f158b81bd1bed03332880a383a45437703761` | `93480b2a883bb0ad075cbf143abe302225ddfd01e333431999c95e378cd8a6c3` |
| server/src/services/heartbeat.ts | `0fb791d721262d024ef2935b3045f4a5489adfa5853d2d54dab15c639d26fe54` | `9ac217e97e5319c850924f083df32be43df11f33f8970ff8efb4a5f776a0c1d9` |
| server/src/services/git-credentials.ts | `0e8bc7031cc7000db3d9828eb84fbd2c22d19657bfcdc5e287f95cc01e05934f` | `0e8bc7031cc7000db3d9828eb84fbd2c22d19657bfcdc5e287f95cc01e05934f` |
