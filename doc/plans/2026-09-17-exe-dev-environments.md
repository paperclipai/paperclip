# Experimental durable exe.dev environments

## Product contract

One environment binds one durable VM for a trusted group of agents. Separate
leases, homes, and worktrees isolate ordinary concurrent work; the VM is the trust
boundary. Bring an exe.dev account and an SSH key. Create from a pinned compatible
image or attach a compatible existing VM. Keep Daytona as Cloud's default.

The experiment is off by default in both products. New environment creation,
probing, discovery, and execution require its flag. Cleanup remains available
when disabled. VM deletion and replacement are always explicit. A VM resource
identity must outlive individual run leases and survive controller restart.

Use existing workspace copyback and native checkpoint semantics. The durable disk
is authoritative between runs. Cloud backup coverage is its existing backed-up
volume for copied/checkpointed paths; no new whole-disk or continuous S3 backup.
No service registry, port allocator, or database-backup feature is in scope.

## Acceptance campaign

1. Offline contracts: flag defaults and server denials, secret references, host
   key checks, immutable image requirement, cross-company/identity rejection,
   atomic resource binding, idempotent cleanup, and no VM deletion in hooks.
2. Reproducible image: frozen dependency lock; runner/provider pack from one source
   revision; all legacy CLI commands available; no package installation at boot;
   boot a fresh VM from the exact published digest.
3. Browser matrix: legacy Codex, Claude, OpenCode and native Codex, OpenCode,
   ACPX Claude, ACPX Codex, each across message completion, plan revision/approval,
   and question/resume. Verify visible status, output, runtime mode, transport,
   usage, artifacts, and cleanup. Missing credentials are failures, not skips.
4. Shared VM stress: concurrent native/native and native/legacy agents, independent
   homes/worktrees, competing first acquisitions, cancellation of one agent while
   others progress, command timeout, large binary and UTF-8 transfers, noisy logs,
   and exact exit receipts.
5. Persistence: untracked/dirty/multiple Git repositories, remote edits between
   runs, unrelated host edits and explicit same-path copyback precedence, controller/plugin
   restart, VM reboot, SSH/WSS loss, missing VM, and explicit replacement from
   verified copyback/checkpoints. Never overwrite an unverified surviving disk.
6. Preview: Vite/HMR through a private exe.dev URL, service alive after agent exit
   and cancellation, unauthenticated visitor denied, authenticated browser allowed,
   60-minute idle and overnight soak when scheduled. Record actual sleep/wake
   behavior rather than infer it from marketing language.
7. Cloud: release-scoped opt-in installs the plugin, canonical-host outbound WSS,
   existing Daytona provisioning unaffected, managed-config and runtime-envelope
   tests, tenant-volume backup coverage documented.

Live logs, screenshots, image digests, and campaign results are generated evidence
and stay outside source control. A passing provider stress script alone does not
establish browser acceptance or qualify every runner profile.
