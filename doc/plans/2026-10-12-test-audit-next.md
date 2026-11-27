# Test audit: consolidate repeated owner fixtures and rendering

Date: 2026-10-12
Branch: `codex/test-audit-next`
Discovery baseline: `b4aee6ea18905690686fb318fa9cc6d4cc71a7e1`
Integration base: `1e0cfcb4fc4ed78d10f46cd60990935af4ac9973` (merged master)
Verified code commit: `4261a7fc1b964e54059c68246a0a4b7ea74bdcea`
Parent cleanup: [PR #15978](https://github.com/paperclipai/paperclip/pull/15978)

This follow-up removes **2,041 net test lines across five files**. Every
registered case and assertion remains. It changes no application source.
The seven complete owner/sibling files pass all **990 cases** before and after.
Workspace typecheck, build, token gates and diff checks pass. The change
consolidates fixture setup while preserving execution count.

The parent PR merged on 2026-10-12 after all remote checks passed and a
fresh Greptile 5/5 review. This branch used a separate managed checkout and
dependency installation. Only its new follow-up commit was replayed onto
the parent merge, with no conflicts or duplicated cleanup commits. All five
test files still exactly match the independently reviewed candidates, and
all 990 owner/sibling cases pass again on the merged base. The follow-up remains
committed locally on its own branch. Earlier cleanup evidence, including its
disclosed local timeout and passing owner reproduction, lives in
`2026-10-12-test-audit.md`.

## Measured change

| File | Before lines | After lines | Net removed | Cases retained |
| --- | ---: | ---: | ---: | ---: |
| server/src/__tests__/environment-runtime.test.ts | 8,110 | 7,223 | 887 | 162 |
| server/src/__tests__/execution-workspaces-service.test.ts | 4,751 | 4,638 | 113 | 67 |
| server/src/__tests__/company-portability.test.ts | 6,194 | 6,100 | 94 | 94 |
| ui/src/pages/IssueDetail.test.tsx | 6,652 | 6,338 | 314 | 141 |
| ui/src/components/IssueChatThread.test.tsx | 5,032 | 4,399 | 633 | 100 |
| **Changed owners** | **30,739** | **28,698** | **2,041** | **564** |

The remaining 426 validation cases are unchanged TaskChatThread (225) and
AppsConnect (201) siblings. Figures exclude this report. No case, timeout,
skip condition, filename, CI route or production seam is removed.

## Owner and keeper decisions

All nominated cases are retained. Each original case remains the primary
keeper of its regression assertions; helpers own only repeated inputs.

- Environment runtime: 71 repeated plugin/lease/worker/foreign-company
  expressions become synchronous file-local fixture builders. Complete
  identity, author, schema, readiness, capability, install-order, stale lease,
  fingerprint and RPC-budget variants remain defaults or explicit overrides.
  Preserve real persisted rows and the actual foreign-company rejection,
  orphan teardown/spool recovery and lease-reuse paths. Dynamic/spread rows
  and the named-constant secret provider stay inline.
- Execution workspaces: 19 repeated task/recovery/branch/runtime/agent inputs
  become synchronous builders. Real Git operations, active claimant/runtime
  rows, locked races, clean/dirty divergence and durable recovery assertions
  remain in their original cases.
- Company portability: 15 identical export invocations use one local helper;
  their distinct fixture data, redaction, permission, import, selected-file,
  logo and membership expectations remain explicit.
- IssueDetail: 98 identical root/provider render frames share one synchronous
  helper. It retains the same QueryClient and root. Four nondefault children
  remain explicit JSX; unsafe undefined/key/ref/spread shapes stay inline.
- IssueChatThread: 70 MemoryRouter/component frames share one synchronous
  helper with fresh original defaults. Supplied callback references, props,
  dynamic expression order, root identity and rerender/remount behavior remain.

TaskChatThread and AppsConnect already have useful fixtures or distinct
transport/identity behavior. A TaskChatThread prototype saved only ten lines
after helper overhead and was rejected. No further layer retirement was
supported in these owners; separate provider, authentication, lifecycle and
storage proof remains valuable.

## Preservation evidence

Original/candidate SHA-256 guards were validated before any checkout edit.
Proposals were prepared outside the checkout during baseline execution.
Independent reviewers checked both groups against the committed baseline.

Server: expand all 105 calls through the 16 actual helper bodies/defaults and
compare all three complete programs. Field order, nested schemas/capabilities,
types/casts, table rows, callbacks, hooks, 1,347 awaits and 1,201 expectation
calls are unchanged. Helpers add no Promise boundary, transaction, UUID,
clock read, receipt, assertion, RPC or reset. Objects and mocks remain fresh.

UI: independently expand all 98 + 70 actual render calls. The complete program
outside those checked expressions is unchanged, including types, callbacks,
actions, waits, timers, teardown and budgets. All 778 expectation calls and
200 declarations remain. Check every thread root identity and dynamic prop
evaluation order; check IssueDetail root/client bindings for shadowing.
Only unique JSX attribute order is normalized; key/ref/spread shapes are
excluded. No React component wrapper or hook is introduced.

Both independent reviews found no preservation blocker. No assertion was
moved or repaired, so no additional production mutation was needed. The
earlier parent PR's mutation proof is recorded in its report.

## Runtime verification and limits

- Complete baseline: seven files, 990 passed, zero failed/skipped.
- Complete candidate: the same seven files, 990 passed, zero failed/skipped.
- Rebased candidate: the same seven files, 990 passed, zero failed/skipped.
- `pnpm --filter @paperclipai/ui typecheck`: pass before integration.
- `pnpm -r typecheck`: pass before integration and at the verified code commit.
- `pnpm build`: pass at the verified code commit.
- Token gates, palette synchronization and character synchronization: pass.
- `git diff --check`: pass.
- The new checkout used its own workspace-linked dependencies and built its
  own TypeScript runner/shared/plugin SDK prerequisites. No dependencies or
  source files were linked to the concurrently changing PR checkout.
- A complete default `pnpm test:run` has not been repeated for this follow-up.
  Its test-only fixture changes have complete affected-owner/sibling proof.
  Browser suites were not run; none of those suites changed. The parent PR
  has its own full CI evidence. No wall-time speedup is attributed to this work.

## Additional retirement search

A bounded independent search found no further defensible retirement of
200 or more lines. Provider-specific behavior, separately implemented
parsers, CSS contrast/theme/layout contracts and runtime/SDK wiring retain
independent proof. Similar source guards or DOM class assertions did not
provide complete behavioral keepers, so those layers remain.
