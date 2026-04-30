# Phase 59: Native Distribution Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 59-native-distribution-foundation
**Mode:** auto
**Areas discussed:** Native shell baseline, Package layout and runtime boundary, Platform capability boundary, Signing/updater inventory, v2.9 regression gates, Tooling/process evidence

---

## Native shell baseline

| Option | Description | Selected |
|--------|-------------|----------|
| Tauri v2 baseline | Small native wrapper around existing Vite UI with signed updater, tray, shortcut, notification, deep-link, and mobile-capable plugin surfaces. | yes |
| Electron/electron-builder baseline | Mature desktop runtime with existing `_refs/multica` reference, but heavier and not current repo source truth. | |
| Delay shell choice | Keep Phase 59 as open research only, forcing Phase 60 to re-decide packaging before signing work. | |

**Auto choice:** Tauri v2 baseline.
**Notes:** Official Tauri docs were checked for updater signing, macOS signing/notarization, Windows signing, tray, shortcut, notification, and deep-link capability. Electron remains a fallback reference only.

---

## Package layout and runtime boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Reserve `apps/desktop` and keep `ui/` canonical | Future native package uses `apps/desktop/src-tauri`, Vite dev URL in dev, and `ui/dist` for packaged builds. | yes |
| Put native shell inside `ui/` | Fewer directories, but mixes web package and native host responsibilities. | |
| Fork a separate native UI | Gives native freedom but risks product drift and duplicate RealTycoon2 UI. | |

**Auto choice:** Reserve `apps/desktop` and keep `ui/` canonical.
**Notes:** Do not add `apps/*` workspace or native dependencies until the first scaffold phase. This avoids lockfile churn during Phase 59.

---

## Platform capability boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Define capability matrix only | Lock what desktop/mobile/native surfaces must eventually expose, but leave implementations to Phase 60-63. | yes |
| Implement tray/shortcut/push now | Adds downstream capability scope too early. | |
| Keep only desktop packaging | Ignores Phase 63 mobile push and deep-link requirements. | |

**Auto choice:** Define capability matrix only.
**Notes:** Phase 59 owns the boundary: Phase 60 signing, Phase 61 updater/channels, Phase 62 tray/shortcut, Phase 63 push, Phase 64 final gate.

---

## Signing/updater inventory

| Option | Description | Selected |
|--------|-------------|----------|
| Document evidence inventory now | Track macOS identity/notarization, Windows trust path/timestamping, updater keys, channel metadata, owners, and secret references before implementation. | yes |
| Wait until signing implementation | Faster now but risks Phase 60 missing credential owners and CI evidence paths. | |
| Store local key examples in repo | Convenient but violates secret hygiene. | |

**Auto choice:** Document evidence inventory now.
**Notes:** Secrets are references only. Updater keys are separate from OS signing identities.

---

## v2.9 regression gates

| Option | Description | Selected |
|--------|-------------|----------|
| Treat v2.9 as shipped baseline | Distribution work can only add gates or fix concrete regressions in DRAFT/NATIVE/MSG/REVIEW areas. | yes |
| Reopen capture flows during distribution | Allows cleanup but risks destabilizing the verified input/review loop. | |
| Ignore v2.9 until Phase 64 | Simpler early phases but lets regression drift accumulate. | |

**Auto choice:** Treat v2.9 as shipped baseline.
**Notes:** The regression bundle should reuse existing shared/server/UI tests, identity gates, release-host/runtime-confidence evidence, and `pnpm typecheck`.

---

## Tooling/process evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Record GSD tool mismatch and proceed narrowly | `gsd-sdk query` is unavailable and `gsd-tools` cannot parse Phase 59 from table-form roadmap, but roadmap clearly lists the phase. | yes |
| Stop because tool init failed | Strict but blocks a valid roadmap phase due to tooling drift. | |
| Rewrite roadmap to fit tooling first | Too broad for Phase 59 discussion and could disturb milestone truth. | |

**Auto choice:** Record GSD tool mismatch and proceed narrowly.
**Notes:** The working tree already has unrelated dirty files. Phase 59 must stage/commit only its own files.

---

## the agent's Discretion

- Exact shape of the foundation document and optional validation artifact.
- Whether Phase 59 implementation remains documentation-only or includes a narrow script/test to validate the document shape.
- Exact wording of the package layout table, provided downstream phases can act without re-asking.

## Deferred Ideas

- Actual Tauri package scaffold and dependencies.
- macOS and Windows signing implementation.
- Signed updater feed implementation.
- Tray/menubar/global shortcut behavior.
- Mobile/Web Push/APNs implementation.
- Public store listing and reviewer-account operations.
