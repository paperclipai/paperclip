# Phase 59: Native Distribution Foundation - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 59 establishes the native distribution foundation for RealTycoon2. It chooses the native shell baseline, defines the package layout and platform capability boundary, inventories signing/updater credential material, and lists the v2.9 DRAFT/NATIVE/MSG/REVIEW behaviors that must become regression gates.

This phase should not implement macOS notarization, Windows signing, release channels, signed updater feeds, tray behavior, global shortcuts, mobile push delivery, or new capture behavior. Those belong to Phase 60 through Phase 64. Phase 59 may add planning/operator documentation and narrow inventory artifacts that downstream phases use as the release evidence contract.

</domain>

<decisions>
## Implementation Decisions

### Native shell baseline
- **D-01:** Use Tauri v2 as the default native shell baseline for RealTycoon2 distribution planning. The current repo is Vite/React/PWA-first with no Electron or Tauri dependency; Tauri is the smaller first wrapper because it can consume the existing web UI while exposing signed updater, tray, shortcut, notification, deep-link, and mobile-capable plugin surfaces.
- **D-02:** Treat Electron/electron-builder as a fallback reference only, not the Phase 59 baseline. `_refs/multica` contains an Electron desktop implementation, but it is not current Paperclip/RealTycoon2 source truth and would introduce a larger desktop runtime before Phase 59 proves the required capability boundary.
- **D-03:** Do not add native framework dependencies or commit lockfile churn in Phase 59 unless a downstream implementation task explicitly needs a scaffold. The foundation deliverable should lock decisions and inventories first; Phase 60/61 can add the actual Tauri workspace once signing/updater requirements are ready.

### Package layout and runtime boundary
- **D-04:** Reserve `apps/desktop` as the future native host package location, with `apps/desktop/src-tauri` for Tauri Rust/config files and `apps/desktop` package scripts for native build/check commands.
- **D-05:** Keep `ui/` as the canonical React/Vite UI package. The native shell should point at the Vite dev server in development and consume `ui/dist` for packaged builds rather than forking the UI source.
- **D-06:** Add `apps/*` to `pnpm-workspace.yaml` only when the first desktop package is created. Do not commit `pnpm-lock.yaml` changes, matching repo policy.
- **D-07:** The first native package should be a host/wrapper around the existing web app and API boundary, not a server rewrite. Local embedded Postgres, CLI onboarding, and server lifecycle remain existing Paperclip/RT2 infrastructure unless a later phase explicitly adds a signed sidecar.
- **D-08:** Package identity should be RealTycoon2-first: app name `RealTycoon2`, stable bundle identifier such as `com.isens.realtycoon2`, and product-facing Korean labels. Paperclip may remain internal infrastructure naming only.

### Platform capability boundary
- **D-09:** Phase 59 locks the capability matrix, not the implementations. Desktop Phase 60/61 must cover signed package artifacts and updater metadata; Phase 62 owns tray/menubar and OS global shortcut; Phase 63 owns mobile push/subscription/token delivery.
- **D-10:** Desktop baseline capabilities are: app launch wrapper, build identity, release channel display, signed updater status hooks, tray/menubar status hooks, global shortcut registration status hooks, deep-link target back to RT2 review surfaces, and notification permission/status hooks where useful.
- **D-11:** Mobile baseline remains PWA/Web Push plus future native/mobile package capability. APNs/native token work must remain Phase 63 scope and must feed the existing board review target/deep-link model rather than introducing automatic apply.
- **D-12:** Native capture from tray, shortcut, or mobile push must enter the Phase 54-57 persistent draft revision and board review inbox path. It must not bypass approval or auto-promote work.

### Signing, updater, and evidence inventory
- **D-13:** The operator inventory must track macOS Developer ID Application identity, Apple Team ID, Apple ID/App Store Connect credentials or key path, hardened runtime entitlement owner, notarization submission owner, ticket stapling evidence owner, and Gatekeeper verification command/evidence.
- **D-14:** The operator inventory must track Windows trust path as an explicit choice: MSIX/Store re-signing, Azure Trusted Signing/Azure Code Signing, Azure Key Vault-backed signing command, or EV/OV certificate path. It must record timestamping, certificate source, secret owner, installer format, and SmartScreen/trust evidence owner.
- **D-15:** Tauri updater key material must be inventoried separately from OS code-signing identities. Required fields are public key, private-key secret reference, key password secret reference if used, rotation owner, storage location, and update metadata signing evidence.
- **D-16:** Updater metadata must be channel-aware from the start: internal, beta, and stable are separate feed identities even if Phase 61 implements the feed later. Every channel record must eventually carry version, artifact URL, checksum, signature, notes, rollout policy, and rollback candidate.
- **D-17:** Secrets must be referenced, not embedded in docs or repo files. Local dev examples may use placeholders only; real keys belong in CI/environment secret stores or Paperclip secret references.

### v2.9 regression gate boundary
- **D-18:** v2.9 DRAFT/NATIVE/MSG/REVIEW behavior is shipped baseline. Phase 59 and later distribution phases may only touch those areas to add regression gates or fix concrete gate failures.
- **D-19:** Regression gate set must include persistent draft revision, quick capture queue, messaging source inbound/signature behavior, capture review filters/reliability report, RT2 identity gate, and release-host/runtime-confidence evidence.
- **D-20:** The focused regression command bundle should reuse existing tests and scripts: `packages/shared/src/rt2-task.test.ts`, `server/src/__tests__/rt2-task-routes.test.ts` with embedded Postgres opt-in where needed, `ui/src/lib/rt2-quick-capture-queue.test.ts`, `ui/src/pages/rt2/QuickCapturePage.test.tsx`, `ui/src/components/Rt2DailyBoard.test.tsx`, `pnpm run test:identity-gate`, `pnpm run rt2:identity-gate`, and `pnpm typecheck`.
- **D-21:** Do not run `pnpm test:e2e` as a default Phase 59 gate. Browser release-smoke and Playwright remain separate distribution verification surfaces.

### Tooling and process evidence
- **D-22:** `gsd-sdk query` is unavailable in this environment and `gsd-tools init phase-op 59` cannot parse the current table-form roadmap, even though `.planning/ROADMAP.md` clearly lists Phase 59. Downstream plans should not treat this as a product blocker; record it as planning-tooling evidence and keep file writes narrow.
- **D-23:** Because the working tree already contains unrelated Phase 56-58/source changes, Phase 59 work must stage or commit only its own files. Do not revert unrelated dirty files.

### the agent's Discretion
- Exact wording and table shape of the Phase 59 foundation document, provided it records shell choice, package layout, platform boundary, credential inventory, and v2.9 regression gates.
- Whether the inventory lives as one Markdown document or a Markdown document plus small JSON fixture, provided secrets are placeholders/references only.
- Whether implementation adds only docs or also a lightweight validation script, provided it does not add native dependencies or lockfile churn in Phase 59.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `.planning/PROJECT.md` - v3.0 milestone focus, RT2-first identity rule, native distribution boundary, and shipped v2.9 baseline.
- `.planning/REQUIREMENTS.md` - `DIST-01` requirement and v3.0 traceability.
- `.planning/ROADMAP.md` - Phase 59 goal, success criteria, and Phase 60-64 downstream boundaries.
- `.planning/STATE.md` - Current v3.0 handoff state and known Windows verification caveats.
- `AGENTS.md` - Korean-first communication, RealTycoon2 terminology, dev command, verification, and lockfile policies.

### Prior Capture Baseline
- `.planning/phases/58-v29-verification-and-distribution-readiness-closure/58-CONTEXT.md` - Locked v2.9 closure boundary and focused DRAFT/NATIVE/MSG/REVIEW regression bundle.
- `.planning/phases/58-v29-verification-and-distribution-readiness-closure/58-01-SUMMARY.md` - v2.9 closure implementation and verification summary.
- `.planning/phases/57-capture-review-operations-and-reliability/57-CONTEXT.md` - Locked review operations and reliability report behavior.
- `.planning/phases/56-messaging-capture-source-installation/56-CONTEXT.md` - Locked Slack/Teams/webhook source installation and signed inbound behavior.

### Existing Release And Verification Assets
- `package.json` - Current workspace scripts, release scripts, identity gates, release-host verification, and lockfile policy implications.
- `pnpm-workspace.yaml` - Current workspace layout; `apps/*` is not present yet.
- `.github/workflows/release.yml` - Existing npm canary/stable release workflow and GitHub environment gates.
- `scripts/release.sh` - Existing npm/GitHub release script, versioning model, verification gate, and cleanup behavior.
- `scripts/create-github-release.sh` - Stable GitHub Release creation flow.
- `scripts/rt2-release-host-verify.mjs` - Existing release-host evidence harness.
- `scripts/rt2-runtime-confidence.mjs` - Existing runtime confidence report generator.
- `doc/RELEASING.md` - Current calendar version, canary/stable, GitHub Release, smoke, and rollback runbook.
- `doc/PUBLISHING.md` - Current package publishing and version rewrite internals.
- `doc/RELEASE-AUTOMATION-SETUP.md` - GitHub/npm trusted publishing and release infrastructure setup.
- `doc/RELEASE-HOST-VERIFICATION.md` - Current release-host evidence and runtime-confidence runbook.

### UI And Capture Source Evidence
- `ui/package.json` - Current Vite/React package scripts and dependency surface.
- `ui/vite.config.ts` - Existing Vite build/dev server configuration that a native wrapper should consume.
- `ui/public/site.webmanifest` - Current RealTycoon2 PWA identity and quick-capture shortcut.
- `ui/src/App.tsx` - Current `/quick-capture` routing.
- `ui/src/lib/rt2-quick-capture-queue.ts` - Existing mobile/native quick capture local queue.
- `ui/src/pages/rt2/QuickCapturePage.tsx` - Existing quick capture UI and source handoff.
- `ui/src/components/Rt2DailyBoard.tsx` - Existing board review inbox and capture reliability UI.
- `packages/shared/src/types/rt2-task.ts` - Capture source/draft/revision/filter/report contracts.
- `server/src/services/rt2-work-board.ts` - Persistent draft/source/review service boundary.
- `server/src/routes/rt2-tasks.ts` - Capture source, draft, public inbound, and reliability routes.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The repo already has strong release evidence primitives: `rt2-release-host-verify`, `rt2-runtime-confidence`, identity gate scripts, canary/stable release scripts, and GitHub release workflow.
- The UI is already a standalone Vite package with `ui/dist` output, which fits a native wrapper consuming web assets without duplicating product UI.
- `ui/public/site.webmanifest` already carries RealTycoon2 name, icons, and quick-capture shortcut; native package identity should extend this instead of inventing a separate brand.
- v2.9 capture reliability assets already provide the regression baseline that distribution phases must protect.

### Established Patterns
- Repo-local operational tooling is implemented as Node `.mjs` scripts under `scripts/`, exposed through root `package.json`, and tested with small fixture/unit tests.
- Release and runtime evidence is written under `.planning/<evidence-kind>/<timestamp>/` with machine-readable JSON and human-readable Markdown.
- Product-facing UI/copy is RealTycoon2-first and Korean-first; Paperclip names remain internal infrastructure.
- Focused tests plus `pnpm typecheck` are the practical default on this Windows host. Broad `pnpm test` can be attempted when feasible, but known timeout/embedded Postgres caveats must be recorded honestly.

### Integration Points
- Add Phase 59 foundation documentation, likely `doc/NATIVE-DISTRIBUTION-FOUNDATION.md`, as the operator-readable contract for Phase 60-64.
- Optional narrow validation can be a script/test that checks the foundation document includes shell choice, package layout, credential inventory, updater key material, and v2.9 regression bundle.
- Future Tauri package should integrate with `ui` build output and existing release evidence scripts rather than replacing release automation.
- Future distribution gates should consume current release-host/runtime-confidence evidence and add signing/updater-specific evidence rather than duplicating v2.9 closure logic.

</code_context>

<specifics>
## Specific Ideas

- Official Tauri docs confirm the updater plugin requires signed update artifacts and a public/private updater key pair; the private key must be protected and `.env` files are not accepted for build signing variables.
- Official Tauri docs show macOS signing can use `bundle > macOS > signingIdentity` or `APPLE_SIGNING_IDENTITY`, and Developer ID distribution requires notarization.
- Official Tauri docs show Windows signing paths including OV certificates, Azure Key Vault, Azure Code Signing, and custom sign commands; unsigned Windows distribution can trigger SmartScreen/trust friction.
- Official Tauri docs show system tray, global shortcut, notification, updater, and deep-link plugin surfaces that map cleanly to Phase 62/63 boundaries.
- Official Electron docs confirm Electron remains a viable fallback but brings its own autoUpdater packaging constraints and Windows/macOS signing requirements, including EV certificate guidance for Windows trust.

External official docs used during auto discussion:
- `https://v2.tauri.app/plugin/updater/`
- `https://tauri.app/distribute/sign/macos/`
- `https://v2.tauri.app/distribute/sign/windows/`
- `https://v2.tauri.app/learn/system-tray/`
- `https://v2.tauri.app/reference/javascript/global-shortcut/`
- `https://v2.tauri.app/plugin/notification/`
- `https://tauri.app/ko/plugin/deep-linking/`
- `https://www.electronjs.org/docs/latest/api/auto-updater`
- `https://www.electronjs.org/docs/latest/tutorial/code-signing`

</specifics>

<deferred>
## Deferred Ideas

- Implementing the actual `apps/desktop` Tauri package remains downstream execution after Phase 59 foundation is accepted.
- macOS signing, hardened runtime, notarization, ticket stapling, and Gatekeeper verification belong to Phase 60.
- Windows MSIX/installer signing, timestamping, Store re-signing, Azure signing, or certificate trust path implementation belongs to Phase 60.
- Internal/beta/stable channel feed, signed updater metadata, download/install/relaunch state, and rollback candidate management belong to Phase 61.
- Resident tray/menubar and OS-level global shortcut behavior belongs to Phase 62.
- Mobile/Web Push/APNs subscription, delivery, retry, token invalid, permission denied, and click-through evidence belongs to Phase 63.
- v3.0 final distribution gate and focused v2.9 regression closure belongs to Phase 64.
- Public store listing, marketing, reviewer accounts, cross-company federation, public marketplace, and autonomous Jarvis apply remain outside v3.0 distribution readiness.

</deferred>

---

*Phase: 59-native-distribution-foundation*
*Context gathered: 2026-04-30*
