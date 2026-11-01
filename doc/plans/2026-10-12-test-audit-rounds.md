# Test audit: repeated setup, duplicate cases and false proof

Date: 2026-10-12. Audit branch: `codex/test-audit-next`. Delivery branch: `codex/test-audit-followup`. Verified code revision: `64370831ebe191e5ce092f85f79b6fb661df7e16`, including master `cc88b61c0918f45f6d3215f5d2d2368c88297046`.

This follow-up removes **5,027 net test lines across 27 test files** and **15 redundant registered executions**. It separately removes **11 unused application lines** from two private test-inspection exports. Most savings come from sharing repeated setup while retaining every distinct case. No wall-time improvement is inferred from line counts.

The earlier merged [PR #15978](https://github.com/paperclipai/paperclip/pull/15978) removed 11,976 net test/support lines and 1,073 redundant executions. The two changes together save **17,003 test/support lines**. These counts exclude audit reports, upstream changes and the fixture portability repair.

## Savings and scope

| Batch | Net test lines removed | Registered executions removed | Preservation |
| --- | ---: | ---: | --- |
| Earlier local runtime/workspace/portability and IssueDetail/IssueChatThread | 2,041 | 0 | All original cases and assertions retained; 990 owner/sibling cases passed. See [the earlier follow-up report](2026-10-12-test-audit-next.md). |
| Route fixtures and duplicate proof | 970 | 5 | Three redundant cases and two identical table executions removed; cancelled-reopen observation repaired. |
| UI fixtures and duplicate proof | 521 | 6 | Exact assertions move into named stronger keepers; two weak observations repaired. |
| CLI, shared catalog and wiki plugin | 238 | 3 | Exact keepers and fixture expansion; genuine run-receipt and positive-write witnesses added. |
| Public API and ticker observations | -10 | 0 | Tests grow by ten lines to replace private-state inspections with observable results. |
| Tool access, policy and gateway | 656 | 1 | One exact omitted-scope duplicate removed; all other matcher and await order retained. |
| Interactions and secrets state services | 611 | 0 | All 180 declarations / 197 cases retained; two AWS lock observations repaired. |
| **Total follow-up** | **5,027** | **15** | **No independent security or lifecycle contract retired.** |

Line savings include all newly added local helper code. The application reduction is five lines of `__inflightGetCount` and six lines of `__secondTickInternals`. Repository-wide caller searches found only their tests. Both module cores otherwise remain byte-identical. Their tests retain sharing, cancellation, stale-account isolation, rendered ticks and timer lifecycle.

The final intended diff has 27 test files, those two application files and audit evidence. No schema, telemetry, runtime service, package manifest, lockfile or CI routing change is part of this cleanup. Incoming master changes were merged, so absent upstream files cannot inflate the savings.

## Removed execution to keeper map

Each retained declaration is its own keeper for setup-only consolidation. The following is the complete map for the 15 removed executions; the three-row influence table accounts for two of them.

| Removed proof | Retained keeper and boundary |
| --- | --- |
| Managed-sandbox duplicate DELETE rejection | Same owner/admin, platform row, DELETE, 403 and code; stronger keeper also forbids blast-radius/removal calls. |
| Agent-skills duplicate GET/POST secret-context check | Mandatory resolver callbacks in both successful route keepers check the same actor/user/source/responsible literal context, adapter type, skip-user-secrets and filtered environment. |
| Company-skills open-default legacy-consent duplicate | Same actor/company/run, deny-missing-consent decision and POST input; successful write keeper checks no consent-gate invocation and the actual write. |
| Two extra missing/wrong-run influence table rows | All three ran the identical zero-argument callback. One retains both POST/PATCH errors, details, two propagation calls and no writes. The identity-variant service sibling and real PostgreSQL race sibling remain. |
| Onboarding missing-auth/no-stored-login duplicate | Warning text moves into `blocks the hire on a warn result that holds adapter_auth_missing, and shows the returned checks`. |
| Interaction connection controls for another viewer | `shows another viewer only who it is waiting for` retains waiting copy, zero buttons, no actions/auth URL and absence of Not now. |
| Legitimate question-card rendering duplicate | `exposes pending question options as selectable radio and checkbox controls` gains positive child count and retains stronger exact radio counts. |
| Addressed-user Connect/Not-now duplicate | `opens the shared connection setup for the addressed user` gains the exact copy and absence checks before executing the real setup action. |
| Non-GitHub-link icon duplicate | `opens external links in a new tab with safe rel attributes` uses the same docs input and retains exact anchor, no GitHub icon, target and rel. |
| External-link trailing-icon duplicate | The same docs-link keeper retains the icon glued to the final character and the original glyph matcher. |
| Hugging Face scope duplicate | `requests Airtable record, schema and comment writes, and Hugging Face repository/job actions` retains the same independent `[read-mcp, read-repos, contribute-repos, jobs]` literal. |
| Whole-catalog method/field invariants duplicate | Full-catalog `appDefinitionsSchema.parse` enforces nonempty ownership modes, required credential placeholders and API-key key placement for every definition; provider-specific permission literals remain. |
| Worktree shutdown formatter duplicate | Real `ensure-seeded` failure retains restore error, safe diagnostic, failed manifest and lock release. The unique migrations fallback expectation moves unchanged into that keeper. |
| Tool-access omitted-provider-scope duplicate | `marks a scope inferred from the request when the provider omits one` calls the identical `connectSlackWithTokenScope(null, ["channels:read"])`, retains all three persisted scope fields and also checks the outgoing authorization scope. Reported over-grants remain separately tested. |

The influence identity sibling uses a fake `counterDb` adapter for locked-row variants. The PostgreSQL sibling independently inserts real rows and races writes. Neither is removed, and fake SQL inputs are not described as durable persistence proof.

## Preservation review and repairs

Every nominated owner was read in full, including hooks, declarations, tables and cleanup, before classification as retain, fix false proof, consolidate or delete. Reviews checked actual owner/caller/history/CI boundaries rather than treating similar names as proof. Separate reviewers expanded the actual new helper bodies and arguments against complete original runtime ASTs. Types and source metadata are normalized separately from the compiler gate. Fields, nested values, fresh allocations, action/query/UUID/Date/callback/await order, tables, timeouts and teardown remain strict outside explicitly reviewed semantic edits.

The tool-access expansion covers 167 helper occurrences, 1,657 remaining matcher calls and 2,645 awaits. The state-service expansion covers 120 helper calls; no DB query is hidden in a new helper, and no new helper manufactures a tested service result. All 106 interaction and 91 secret cases remain. Two AWS repairs add two provider-call assertions while retaining the original durable results.

Review restored or strengthened these contracts before cutover:

- Restore the no-agentMap resolved footer/chip case byte-for-byte; a richer mapped-agent case cannot prove its fallback.
- Match the exact external `<a href="https://example.com/docs"` prefix; href/target/rel alone could pass on a span.
- Issue a fresh successful same-path GET after an unrelated 401 and after all callers abort, with exact two-fetch counts and independent values.
- Keep an inactive ticker probe beside an active peer; only the active output may tick, and its unmount must clear the last timer.
- Observe actual authenticated account-binding text after waiting, and mount the Claude login card positively before asserting absence of Use saved login.
- Require cancelled bare-agent reopen to return the exact 409/error before writing a comment. The old broad status allowance accepted 201.
- Capture and return the original wiki SDK `sendMessage` receipt unchanged, and compare its genuine run ID to the operation UPDATE bindings. Positive source/page write counts prevent empty `.every` predicates passing.
- Confirm real account-home lock-holder entry, observe actual AWS create/version provider entry, assert exclusion while parked and exact eventual event order. A separate baseline secret preserves the tested rotation's original 1 → 2 result. Immediate rejection observers and `finally` release/all-settle preserve failure cleanup.

Wiki database witnesses inspect emitted SQL and bindings through the SDK's recorder. They do not claim that the recorder executed real SQL. Assertions guaranteed by its unconditional host-list markup were removed without retiring the real title/binding/configuration-link behavior.

## Falsification and complete positive controls

[The compact evidence record](2026-10-12-test-audit-controls.json) preserves actual source SHA guards, independent expansion results and mutation assertion receipts. It records 18 executions: 14 route/UI/wiki mutations, two original AWS weak controls and two repaired AWS controls. The original AWS cases pass their deliberate bypasses; the repaired cases fail on actual provider entry before lock release. All **16 repaired or retained keeper mutations** fail at the intended assertion, and every mutated source is restored byte-for-byte in `finally` before ordinary testing.

| Complete unmutated control | Result |
| --- | --- |
| Round 4 selected owners and siblings, including standalone wiki | 1,455 / 1,455 passed across 58 files; zero failed/pending. |
| Tool-access owners and state-service keeper baselines | 623 / 623 passed: 491 tool cases plus 132 state siblings; zero failed/pending. |
| Final state-service owners and siblings | 329 / 329 passed across eight files: 197 owners plus 132 siblings; zero failed/pending. |
| Canonical worktree/shared seed-source control | 80 / 80 passed; zero failed/pending. |
| Workspace `pnpm -r typecheck` | Passed at the verified code revision. |
| UI `pnpm check:token-gates` | Passed at the verified code revision. |
| Workspace `pnpm build` | Passed at the verified code revision. |
| Full default `pnpm test:run` | Invoked at the verified code revision. The completed result is recorded in the follow-up PR’s Verification section. |
| `git diff --check` | Passed before evidence publication; delivery also checks its final evidence diff. |

Rows overlap; they are separate receipts and must not be summed into a unique test count. Root Vitest excludes standalone wiki, so its three complete files were also run with its own existing configuration. Browser suites were not run: this change does not touch browser-suite sources or change a product journey. No deadline, retry, skip or shard was weakened for this audit.

## Portability and environment controls excluded from savings

The initial 1,157-case main baseline had 14 failures, all in CLI worktree fixtures using `/var` where the production guard correctly requires canonical `/private/var`. A separate shared seed-source baseline had the same alias failure in eight cases. A separate commit wraps only 38 fixture-allocation parents with `fs.realpathSync(os.tmpdir())` (35 CLI, three shared). It preserves every case/assertion and every explicit attacker-symlink negative. The complete 80-case repaired control passed; none of this is counted as pruning.

The standalone wiki package declares React as a peer, and this checkout disables automatic peer installation. Its baseline initially could not collect two files. An ignored node_modules link supplies the existing pinned React 19.2.8 from this same worktree. All 101 standalone baseline cases then passed. This setup changes no manifest or lockfile and links no dependencies across worktrees.

PR CI and exact-head review results belong on the follow-up PR. The report records local evidence at an immutable code revision; later evidence-only commits do not change the tested source. Full source ledgers and proposal staging files remain temporary, while the decisions, keeper map, actual preservation receipts and falsification outcomes above are preserved in the repository.
