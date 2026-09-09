## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - Plugins extend the host, and each worker→host call is gated on the capability list stored in the plugin record
> - That stored list is the grant of record, so it must only change when an operator agrees to the change
> - Today `upgradePlugin` throws on any version that adds a capability, so the documented `upgrade_pending` approval path is unreachable
> - Operators therefore replace the package on disk by hand, which leaves the stored grant behind and silently denies every new capability
> - The host reports neither problem: there is no approval route, and no warning, health check, or API field for the mismatch
> - This pull request makes the escalation approvable and makes the mismatch visible
> - The benefit is that plugins can add a capability in a release, and an operator can see and approve exactly what they grant

## Linked Issues or Issue Description

Fixes: #8846
Refs #6702

Issue #8846 covers the upgrade half of this change. The drift half has no issue, so it is described below.

**What happened?**

A plugin package was replaced on disk and the worker was restarted. The stored manifest kept the capability list captured at the earlier activation. The new code ran against the old grant, so every host call that needed a newly declared capability was denied. Nothing on the host reported the cause. There was no warning, no health check, and no field on `GET /api/plugins/:pluginId`. The only way to see the mismatch was to read the `manifest_json` column directly.

Operators reach this state because the supported path is closed. `upgradePlugin` throws on any upgrade that adds a capability. The error text says that approval is required, but the host has no approval route, flag, or override. This is issue #8846.

The two behaviours also disagree on security. `upgradePlugin` refuses to grant a new capability. Activation grants whatever the package on disk declares, and it does so silently. The guard sits on the path that refuses, not on the path that grants.

**Expected behavior**

1. An upgrade that adds capabilities parks the plugin in `upgrade_pending` and reports the added capabilities. The operator then approves them and the upgrade completes.
2. A stored manifest that no longer matches the package on disk is visible in the API and in the health check.

**Steps to reproduce**

1. Install a local plugin v0.1.0 with capabilities `["events.subscribe"]`.
2. Bump the package to v0.2.0 and add `"jobs.schedule"` to the manifest.
3. Call `POST /api/plugins/:pluginId/upgrade`.
4. The call fails. The plugin stays on v0.1.0 and never enters `upgrade_pending`.
5. Replace the package directory on disk with v0.2.0 and restart the worker.
6. Call a host method that needs `jobs.schedule`. The host denies the call. No host log, health check, or API response explains why.

**Paperclip version or commit**

Reproduced on `master` at commit `165ca56a2`. This branch is rebased on that commit.

**Deployment mode**

Self-hosted, `local_trusted`, with the plugin installed from a local path.

## What Changed

- `upgradePlugin` returns `{ addedCapabilities, applied }` instead of throwing. It accepts `approveCapabilities`.
- `upgradePlugin` writes the new manifest only when the caller approves every added capability. If any added capability is unapproved, the stored grant stays unchanged and `applied` is `false`. The new package still gets fetched and validated on disk.
- `PluginLifecycleManager.upgrade` returns `PluginUpgradeResult`. It moves the plugin to `upgrade_pending` when the upgrade is not applied.
- `POST /api/plugins/:pluginId/upgrade` accepts an `approveCapabilities` string array. It returns `upgrade: { applied, addedCapabilities, requiresApproval }`. It rejects a malformed `approveCapabilities` with HTTP 400.
- New `inspectManifestDrift` compares the stored manifest with the package on disk. It reports the two versions and the added and removed capabilities. It never throws. An unreadable package returns `packageReadable: false` with the reason.
- `GET /api/plugins/:pluginId` returns a `manifestDrift` field.
- `GET /api/plugins/:pluginId/health` adds a `manifest_drift` check. The check fails, and `healthy` becomes `false`, when the capability sets differ or the package cannot be read. The message names the missing capabilities and the command that resolves them.
- Activation still adopts the manifest on disk, but it now logs a warning that names each capability granted this way.
- `doc/plugins/PLUGIN_SPEC.md` documents the approval loop in §15.3 and adds §15.4 "Manifest Drift".

## Verification

Automated tests, run on this branch after the rebase onto `165ca56a2`:

```
cd server
npx vitest run src/__tests__/plugin-capability-drift.test.ts src/__tests__/plugin-routes-authz.test.ts
```

Result: 2 files passed, 49 tests passed.

`src/__tests__/plugin-capability-drift.test.ts` is new. It covers:

- an unapproved escalation is reported and not granted
- an upgrade applies when every added capability is approved
- an upgrade is held when only part of the escalation is approved
- an upgrade that adds no capability still applies
- drift reports capabilities the package declares but the grant lacks
- drift reports capabilities still granted that the package dropped
- drift reports no difference when the package matches the stored manifest
- an unreadable package is reported, not thrown

`src/__tests__/plugin-routes-authz.test.ts` is extended for the new route contract and keeps the existing admin checks on the upgrade route.

Manual check:

1. Install a local plugin, then bump its manifest to add one capability.
2. Call `POST /api/plugins/:pluginId/upgrade` with no body. The response has `upgrade.applied: false` and `upgrade.requiresApproval: true`, and lists the added capability. The plugin is `upgrade_pending`. The stored capability list is unchanged.
3. Repeat the call with that capability in `approveCapabilities`. The upgrade applies and the plugin returns to `ready`.
4. Replace a package on disk without an upgrade. `GET /api/plugins/:pluginId` reports `manifestDrift`, and the health check fails with `manifest_drift`.

Typecheck: `npx tsc --noEmit` in `server` reports 7 errors. All 7 are in `src/services/native-runtime/native-session-executor.ts`, which this pull request does not modify. No error comes from a changed file.

## Risks

Medium risk, and it is a behaviour change on one route.

- **Breaking change for callers of the upgrade route.** The success body was the plugin record. It is now the plugin record plus an `upgrade` object. A caller that reads plugin fields off the top level still works. A caller that treats HTTP 200 as "upgrade applied" is now wrong, because an upgrade that awaits approval also returns 200 with `upgrade.applied: false`. Callers must read `upgrade.applied`.
- **An upgrade that adds a capability no longer throws.** Any caller that depends on the throw to detect an escalation must switch to `addedCapabilities`.
- **No migration and no schema change.** Drift is computed on demand from the package on disk, so no column or backfill is needed. The change is safe to roll back.
- **The health check gets stricter.** A host that already carries manifest drift will report `healthy: false` after this change. That is the intended report of a real condition, but it can turn a currently green plugin red on first deploy. The message names the fix.
- **Drift inspection reads the filesystem on two read routes.** Both call sites wrap the call and degrade to a diagnostic field, so a filesystem fault cannot fail the plugin detail route or the health route.
- **Activation is deliberately unchanged.** It still adopts the capability list of the package on disk, so a user who can write to the plugin directory can still self-grant a capability across a restart. This pull request only makes that grant loud. Closing it needs a trusted-source rule that does not break bundled plugins on a host upgrade, which is a larger design decision and belongs in its own change.

> For core feature work, check [`ROADMAP.md`](ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

Checked. `ROADMAP.md` lists the plugin system as shipped and asks contributors to keep the core thin. This is a bug fix inside the existing plugin lifecycle. It adds no subsystem and duplicates no planned core work.

## Model Used

Claude Opus 5 (Anthropic), model ID `claude-opus-5`. Extended thinking enabled. Tool use enabled for repository edits, test runs, and typechecks. A human directed the work, reviewed the diff, and verified the test results.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge
