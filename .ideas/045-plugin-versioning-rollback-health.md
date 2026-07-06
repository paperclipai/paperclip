# 045 — Plugin Versioning, Rollback & Health

## Suggestion

The plugin system is one of Paperclip's richest surfaces (adapters, skills, routines, host
services, jobs, sandboxes), and the registry already tracks a plugin's `version` / `apiVersion`
and supports updating the manifest "on upgrade" (`plugin-registry.ts`, `plugin-lifecycle.ts`).
But the *operational* lifecycle is thin: there's no **pinning, rollback, or health monitoring**.
A plugin upgrade that breaks an adapter or a host service can take down part of a running company,
and the operator's only recourse is to manually fix forward — risky for a system meant to run
autonomously 24/7, where a bad plugin update at 2am can silently wedge agents until morning.

Add **operational plugin lifecycle management**: version pinning, safe upgrade with automatic
rollback on failure, and continuous plugin health checks.

## How it could be achieved

1. **Version pinning & history.** Let operators pin a plugin to a known-good version and keep a
   version history. The registry already stores `version`/`apiVersion`; add the prior-version
   record and the ability to re-activate it.
2. **Staged upgrade with health gate.** On upgrade, bring the new version up, run a health probe
   (load, capability validation — `plugin-capability-validator.ts`, `plugin-manifest-validator.ts`
   already exist — plus a smoke check), and only cut over if it passes. If it fails, **auto-roll
   back** to the pinned version and raise an inbox alert.
3. **Continuous health monitoring.** Watch running plugin workers/host services
   (`plugin-worker-manager.ts`, `plugin-host-services.ts`) for crashes, error spikes, and
   unresponsiveness; surface plugin status (healthy/degraded/failed) and auto-restart or disable a
   plugin that's flapping — the plugin analog of agent reliability SLOs (idea 044).
4. **Blast-radius containment.** A failing plugin should degrade only its own capability, not the
   control plane — make health failures isolate the plugin (the sandbox/host-service boundary is
   already there) and clearly mark dependent agents as affected.
5. **`apiVersion` compatibility checks.** Block or warn on upgrades whose `apiVersion` is
   incompatible with the host before they're allowed to activate, rather than discovering it at
   runtime.

## Perceived complexity

**Medium.** Validation, lifecycle, and worker-management primitives already exist, so this is
composing them into a managed upgrade/rollback/health flow plus a version-history store — not new
foundations. The genuinely tricky parts are stateful plugins (a rollback must handle data/schema
the new version may have migrated — overlaps with `plugin-database.ts`) and defining a meaningful
per-plugin health check generic enough to apply across plugin types. Ship pinning + manual
rollback + health status first; automatic staged upgrade/rollback is the higher-assurance next
tier.
