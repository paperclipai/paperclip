# Pool member runtime settings

Goal: configure each pool member like the corresponding direct harness, run Claude via Legacy first with Codex as fallback, and manage pools on a dedicated settings page.

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
