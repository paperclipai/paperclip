# Pool member runtime settings

Goal: configure each pool member like the corresponding direct harness, run Claude via Legacy first with Codex as fallback, and manage pools on a dedicated settings page.

Switching harnesses in the agent editor keeps the runner choice and retains each harness draft, including its model, execution settings and account binding. Returning to the original harness restores its previous dirty state. Discard and a refreshed saved agent invalidate these draft snapshots. The form identifies the active runner so native and Legacy controls can be compared with the corresponding pool member.

Codex settings depend on the selected runner. Paperclip Runner exposes its supported lifecycle and permission settings; Legacy exposes CLI/ACP engine settings, sandbox bypass and fast mode. Both the agent and pool forms use the same Codex controls. Enable search belongs to Legacy CLI only and is removed when switching to ACP. Command overrides and host paths remain agent environment settings. Member search and fast-mode values are cleared before applying the next member so fallback cannot inherit the previous member's tuning.

Architecture: the shared pool member contract owns explicit runner choice and validated harness tuning. The existing router owns candidate selection and immutable execution pins. Heartbeat admission and dispatch consume the selected adapter without reinterpreting it. Existing credential preparation, authority, settlement, and session isolation remain authoritative. UI reuses direct harness controls and owns only editing and navigation.

Tech: TypeScript, Zod, React, TanStack Query, Vitest; existing company-scoped pool persistence without a database schema migration.

Spec: the user's approved request in this chat, doc/SPEC-implementation.md, DESIGN.md and applicable rules/*.mdc.

## Global constraints

- Preserve omitted-field V2 behavior and existing pools/pins. No automatic pool names or templates.
- Explicit Legacy must use its existing qualified adapter. Do not bypass native Windows ACPX platform checks.
- No credentials, environment, instructions, workspace, or private session storage in member overrides. Existing company/task policy gates remain authoritative.
- Keep native and legacy failover settlement owners and fresh-session boundaries intact.
- Preserve unrelated live checkout edits. Build in this isolated worktree, integrate only scoped changes for live acceptance.
- UI uses semantic tokens and accessible labeled fields. Cancel and Save share one footer row.

## Tasks

1. Shared/runtime contract and dispatch (packages/shared and server): first write failing round-trip and adapter-selection tests, add optional runner and strict member settings, propagate them through conversion, snapshots, selection, admission, resume and fallback. Verify focused router, pool admission, cooldown and heartbeat suites. Exercise mixed legacy/native execution and policy rejection.
2. Dedicated Pools UI (ui): first write failing editor/navigation/member tests, add Settings > Pools with a left list and right create/edit panel, initially unselected. Remove templates and Connections embedding. Reuse direct harness fields for runner/engine/model/effort/account and relevant tuning. Verify focused component tests and token gates.
3. Integration and acceptance: independently review both tasks and fix valid findings. Run affected verification. Integrate scoped edits into the live checkout and ensure the running process loads them without changing authentication settings. Configure the QA Pool verification agent with Claude Legacy/CLI first and Codex fallback; prove real two-turn Claude chat, persisted selection, and a controlled supported fallback if available. Record actual evidence and remaining gaps honestly.
4. Delivery: update pool documentation and review the final revision; preserve prior PR/conflict evidence and use repository PR requirements if publishing. Do not call local checks remote CI or a successful Claude turn proof of fallback.

## Review focus

Adapter identity must survive persistence/recovery; member config cannot inject authority or credentials; runner cooldown differs by adapter/engine while account quota remains shared; taskless explicit native members must not silently downgrade. UI must handle empty, create, edit, read-only, load error, revision conflict and save error states without hidden defaults.

## Verification record

- Native Windows x64, Node 26.0.0, repository-pinned pnpm 9.15.4. Isolated worktree starts at 180829e4ec6d14526d11a5861be19122738f09e7. Scoped source changes are also applied to the existing authenticated/private localhost:3100 checkout; unrelated edits are retained.
- Shared contracts 26/26, runtime helpers 5/5, cooldown isolation 2/2, provider-limit regression 3/3 passed. UI focused coverage comprises 108 unique tests across ten suites. UI/shared/server TypeScript checks and token gates passed.
- The first assembled V2 run hit its 60-second bound; a diagnostic rerun exposed a real `provider_limit_wait` cancellation of the Codex successor. The provider-limit owner only recognized V1 router bindings. It now uses `effectiveAiConnectionInput`, matching the established pool exemption while retaining account cooldown enforcement. The V2 quota-to-Codex lifecycle and four native/Legacy prestart cooldown cases then passed (5/5).
- A broader router run passed 91/94. Its cold V1 Pi fixture timed out and unregistered its mock before its active run drained, causing actual Pi discovery and contaminating the following two native cases. The fixture now drains before unregistering and uses the existing 90-second cold-runtime budget. Pi plus all four prestart cases passed (5/5). The final full-router run passed 94/94 in 165.41 seconds on the same Windows host with persistent transform caching.
- Standard verification selection requests broad CI coverage because the connection runbook is a global CI input. Focused local evidence does not replace that coverage. No remote CI result is claimed for this revision.
- Live QA agent: `012eff67-bedb-4f1a-a594-0d3d6fe89ad4`, company `cefcfb11-37f8-48f0-89e5-9bd4822c4c89`. Dedicated test pool `c1570508-a2de-46c4-92d4-e13de5d0de2f`, final order Claude Legacy/CLI then Codex Legacy/CLI. Existing pools remain intact.
- Live Claude runs `e8b37908-d5ff-4130-856d-246c38add807` and `493bfc45-afc3-47e0-8d35-6db4d15b086e` succeeded using `claude_local`, `engine: cli`, `claude-sonnet-4-6`. The second run's incoming session matched the first run's outgoing session. The QA agent classified the artificial exact-output smoke prompt as an injection and refused that string; the follow-up correctly discussed its previous answer. This proves execution and continuity, not compliance with the original output request.
- For live admission fallback, only the dedicated QA pool temporarily selected unsupported native Claude on Windows. Fresh conversation `2bac8c8e-ede5-4ae5-905b-b5fde4b39406` automatically used Codex Legacy/CLI (`gpt-5.6-sol`); run `1837a683-4f68-42a5-b679-aafc6890c651` succeeded. Pool revision 3 restores Claude Legacy/CLI first and Codex Legacy/CLI second. This is real unavailable-member fallback evidence; the quota-settlement successor journey uses controlled integration adapters.
- After the final server restart (new process created 2026-11-11 23:21:43 CET, authenticated/private health ready), fresh conversation `d526006d-cd54-4e1b-856f-d0d8bd32fdaf` again chose Claude Legacy/CLI. Run `a31e15de-f93d-4526-aa47-a4bb8395df6e` succeeded and answered the ordinary role question normally. Pool revision 3 and the restored member order were confirmed read-only against the intended instance database.
- Fresh-worktree preflight was blocked by the baseline patch/lockfile mismatch; the first fallback install also encountered Windows path length. Dependencies were installed offline with a short virtual-store path, keeping the tracked lockfile unchanged. Existing unchanged Runner/eval-kernel/plugin build artifacts and generated Storybook catalogs were reused for local TypeScript checks. No fresh Runner/Rust build, release build or remote CI pass is claimed.

## Follow-up: shared editor and pool sidebar

The user's reference is the chat teammate sidebar: search and an icon-only add action above a list, a visible divider, and a distinct selected row. The details area starts empty. Existing pool names remain user data.

Replace the bespoke pool runtime controls with the actual agent adapter field renderer and shared section/Advanced presentation. A semantic stored-key allowlist restricts pool fields to the existing validated member configuration; host paths, credentials, workspace, instructions and environment remain agent-owned. Agent forms and pool forms must consume the same provider field components rather than duplicate controls.

Verify sidebar search/create/select, supported field parity and edits across harness/runner choices, agent form regressions, typechecking and token gates. Apply only the reviewed follow-up diff to the live checkout and verify the sidebar and Advanced controls through the browser extension.

## Follow-up verification record

- Shared runtime sections are used by the agent form and pool members. Supported provider fields are selected by stored configuration keys from the shared validation policy. Default ACP settings remain visible and their create-form values persist, including Claude permissions. Native Claude does not show an empty host Advanced section.
- Final Windows checks: 215 agent/sidebar tests, 84 additional unique adapter/member/parity/schema UI tests, 21 Claude builder tests, 66 Codex builder tests and 26 shared contract tests passed (412 total). UI TypeScript and token gates (1534 files) passed. Independent review approved the corrected source and parity tests.
- Native Windows Node 26.12.1; final UI production build passed in 15.28 seconds with existing chunk-size warnings. Scoped source and generated UI were applied to the running checkout. All four unrelated live files retained their original hashes. No backend restart was required for this UI refinement.
- Browser-extension acceptance on localhost:3100: initial empty detail, search/filter/clear, plus opening blank creation, selection of the saved QA pool, Advanced Run Policy expansion and a numeric timeout edit were verified. Cancel discarded the temporary edit; reopening showed the saved default timeout. Screenshot: pool-shared-editor.jpg. Saved Claude Legacy/CLI first and Codex fallback settings remain intact. Previous live provider-run evidence above remains separate from this UI acceptance.
- No remote push or CI result is claimed for this follow-up.

## PR integration, 2026-11-12

- Replayed the two feature commits onto the existing Pool PR branch and merged upstream through `9c56e5465c9f`. Kept upstream recovery and pool settlement behavior. Regenerated the Pool migration as `0469_special_stature`, with the upstream journal prefix and guarded earlier-branch SQL preserved.
- Corrected the open taskless Codex confinement finding. Both bypass aliases are false, workspace isolation is required, child networking is disabled, and native-inert escape settings are refused. The existing CLI argument builder is exported through the adapter's server entrypoint for cross-package regression testing.
- Current PR source passed 248 UI tests, 24 taskless/policy tests, 33 native capacity/reset/executor tests and 30 selected Runner tests. UI and complete server TypeScript checks, the Runner TypeScript build, database compile and migration checks, token gates, and the UI production build passed. Independent merge and focused security reviews approved the changes.
- Preserved failed attempts: the first native lifecycle run failed on Windows platform eligibility and was rerun with an explicit supported-host fixture; production gates remain active. Typechecks initially used stale ACPX/Runner dependencies and caught a test import crossing package boundaries. Patched ACPX 0.22.0 and rebuilt declarations removed the dependency errors; using the adapter's public entrypoint removed the import error. The complete sidecar attempt hung and native Rust tests remain blocked by the local MSVC linker library. These are not claimed as passing checks.
- Local develop integration carries the feature commits and taskless correction without pulling the entire upstream branch into the separate local integration history. Preserve unrelated live edits during the final fast-forward. Remote CI and current-head automated review remain separate gates after push.

### Current-head review corrections

- Greptile reviewed `d15d8d500c` at 3/5 and identified two valid dispatch/verification defects. Dispatch now rechecks the original agent or company-projected policy rather than interpreting the selected member's settings as source policy. Verification resolves the execution environment before selecting a member and reuses that environment for probing and its digest.
- The fresh security scan identified unsafe native Codex to Legacy continuation. The transition now uses the frozen predecessor selection under the pin lock. Native Codex and unknown historical identities cannot continue through an unconfined Legacy member. Frozen restrictive native ACPX/OpenCode permissions require an explicit matching compatible successor. Initial virtual Pool to Legacy selection remains available.
- The actual company-run tests exposed a managed-auth rejection of the generated confinement arguments. The managed-auth owner now accepts only the two exact OpenAI confinement assignments, separately within each argument array. Authentication/profile overrides and injected or malformed settings still fail. A compatible two-account Codex fixture verifies backup allocation without weakening source isolation.
- Red/green qualification: three assembled dispatch cases plus existing policy checks passed (27 at that revision), 55 lifecycle/classification tests passed, eight final continuation-policy cases passed, four managed-auth checks passed, and all three assembled company cases plus the historical Legacy cooling case passed. The complete server typecheck passed after these changes. A full router recheck is running; the preceding 90/94 result is not a pass and its four failures retain their targeted corrections. An additional provider-API run passed its test bodies but failed PostgreSQL teardown, so it is not reported as a suite pass.

### Host receipts and target engine corrections

- The full router rerun passed 94/94. Upstream then advanced to `827bd21017`; the only manual retry conflict preserved both the four-attempt quota budget and the interrupted-preparation budget. All 41 retry tests and the server typecheck passed after the merge.
- Fresh review on `7f707e093a` found two valid issues. Claude, Codex, Gemini and Kimi now publish host-created engine-unavailable bootstrap evidence through the canonical top-level execution-recovery contract. Completion continues to discard forged nested provider metadata. The pool sandbox guard now checks the effective target engine, retaining a compatible CLI choice when a member omits its engine and rejecting explicit ACP or Auto when it cannot preserve the source scopes.
- The engine selection regressions reproduced both incorrect guard acceptance and an incorrect persisted database pin. Final focused selection checks passed 13/13. All twelve adapter proof assertions passed after the migration; the six completion assertions, including forged-proof refusal, passed but that command failed its Windows PostgreSQL shutdown check. A separately owned isolated test database is being used for a clean completion rerun; no failed command is counted as a pass. Independent source review and the server typecheck passed.
