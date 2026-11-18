# Shared skill repository assets implementation plan

## Linux scope after Windows downscope

The current contribution targets isolated native Codex on Linux, including WSL.
Native Windows runtime qualification is deferred and is not a release gate for
this Linux scope. Keep saved-context compatibility, source and delivered byte
checks, and portable filesystem fallbacks. The Windows measurements below are
historical evidence, not a native Windows support claim.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage one verified copy of each authorized repository snapshot per native runtime, while preserving exact skills, relative references, old sessions and Legacy compatibility.

**Architecture:** Selected repository skills resolve to normalized version references instead of full per-skill projections. A versioned native context carries shared repository assets and small discovery bundles. The common materializer stages those repositories once; company selection locks cover metadata admission and durable pins rather than downstream file preparation.

**Tech stack:** TypeScript, Node filesystem APIs, Drizzle/PostgreSQL, existing PRP JSON schemas and generated TS/Rust contracts; existing native Codex and remote staging implementations.

**Spec:** [Approved design](2026-11-17-shared-skill-repository-assets-design.md).

## Global constraints

- No live server restart, global agent conversion or credential change during implementation.
- Keep company authorization, durable version pins, immutable manifests, budgets, approvals and audit with their owners.
- Windows must verify bytes on use; do not enable timestamp-only trust or follow arbitrary links.
- Retain old execution/context layouts for recovery. Reserve native input v12: local pool work already uses v11, even though upstream currently stops at v10. Do not reuse v11.
- Legacy and unqualified providers keep an explicit compatible portable projection until qualified.
- Work in the managed isolated worktree from upstream/master. Preserve local integrated pool/v11 changes when later applying the feature to develop; do not deploy an upstream checkout over the live installation.
- Existing asset limits remain 10,000 files/64 MiB per native asset. The shared repository counts once per asset rather than once per skill.

## Review focus

1. Two skills from one repository must not leave hidden full copies in server version projections, native assets or provider homes.
2. A second agent's already-admitted preparation must progress while the first holds a slow repository read; retention must not delete an active source.
3. Wrappers, explicit skill invocation and read tools must locate the original entrypoint after a remote root rewrite, including nested runtime names and Unicode paths.
4. Old saved native inputs must retain their old canonical digests and resume without repinning or destroying state; unsupported new layouts fail permanently before provider launch.
5. A changed shared source or delivered file must be rejected/rebuilt on a warm Windows run, including restored mtime and path substitution.

## Task 1 — Versioned shared repository contract

**Files:** `packages/paperclip-runner/src/contracts/runtime-context.ts`, `native-execution.ts`, their existing tests; `protocol/provider-schemas/runtime-context.schema.json`; `scripts/generate-runtime-context-contract.mjs` and its generated TS/Rust outputs; native execution schema/compatibility registries located by import search.

**Interfaces:**
- Add `NativeRuntimeSkillRepository = { bundle: NativeRuntimeAssetReference; entryPath: string; policyPath: string | null }` and optional `repository` on the existing runtime skill entry; `bundle` on that entry remains its small discovery bundle.
- Export `nativeRuntimeContextAssets(context): NativeRuntimeAssetReference[]` as the unique manifest-identity inventory including instructions, skill bundles and repository bundles. Reject conflicting metadata for one digest.
- Add native input v12 for contexts with repository references; retain all existing schema parsers. A context with the new representation cannot be sent as an older native input.

- [ ] Add failing parse/digest/inventory tests: two skills share one repository asset, absent `repository` preserves existing digests, changed entrypoint/policy/repository changes the digest, duplicate conflicting asset metadata fails, and an older execution schema rejects the new form.
- [ ] Run the owning contract tests and record the expected assertion failures.
- [ ] Implement exact-key parsing, canonical hashing, normalized path validation and v12 admission. Keep the new field absent from old canonical payloads.
- [ ] Regenerate the runtime-context contract with its owner script; synchronize protocol/schema/provider-pack fingerprints rather than hand-edit generated validators.
- [ ] Pass the contract tests and appropriate generated-contract checks. Commit this contract slice.

## Task 2 — Metadata admission and shared server assets

**Files:** `packages/adapter-utils/src/server-utils.ts` (`PaperclipSkillEntry`); `server/src/services/company-skills.ts`, `skill-execution-content.ts`, `skill-package-store.ts`, `skill-package-runtime.ts`, `skill-version-cache.ts`, `skill-package-cache.ts`; `heartbeat/execution-configuration.ts`; native `runtime-context.ts`, `skill-asset-cache.ts`; focused existing package/version/runtime tests and a new shared-repository preparation test.

**Interfaces:**
- Add opt-in `repositoryLayout: "shared"` to runtime skill entry options. Add `PaperclipSkillEntry.repository?: { companyId: string; skillId: string; versionId: string; snapshotId: string; entryPath: string }`. Native consumers using this option must not read a portable `source` projection for that entry.
- `skillExecutionContent(db).withRepositoryVersion(reference, consume)` resolves the exact admitted version and verified repository source, retaining the storage owner's read/publication protection through the callback without a company-wide DB transaction for file work.
- A narrow package-cache read/publication lease protects restore/read/trim of the same cache directory. Metadata admission/pin publication keeps its existing short company lock; package reads cannot acquire that company lock after taking a package lease.
- `materializeSelectedSkills` uses a per-preparation repository flight keyed by authorized snapshot/content identity; materializes one native repository asset and small wrapper/policy bundles.

- [ ] Red/green: two selected skills from the same repository invoke repository materialization once and create no full portable version projections; standalone and Legacy entries stay unchanged.
- [ ] Red/green: gate one slow repository consumer and prove another agent's metadata selection/pin callback can finish before release. Exercise concurrent trim/cold publication and verify active bytes cannot be removed. Avoid introducing an inverse lock order.
- [ ] Preserve access rechecks, selection order, exact saved version maps, missing/denied skill failures and immutable local-source snapshot capture.
- [ ] Implement shared native resolution outside the long company lock, one repository asset per preparation and deterministic small wrapper/policy generation. Reuse existing storage and content-addressed assets; add no database authority cache or schema unless proven necessary.
- [ ] Pass the package/version/selection/native context tests, including cross-company denial and differing snapshot versions. Commit the server slice.

## Task 3 — Shared provider layout and transport

**Files:** `packages/paperclip-runner/src/drivers/runtime-context-materializer.ts` and tests; `src/backends/runtime-context.ts` and tests; provider asset-root helpers; `server/src/services/native-runtime/remote-launch-assets.ts`, `runtime-asset-retention.ts`, `runtime-context.ts` rehydration, `native-execution-input.ts` skill readers; all asset inventory consumers located by `skill.bundle`/`context.skills` import search.

**Interfaces:**
- The common materializer accepts the versioned context and keeps `skills/<runtimeName>/` plus sibling `repositories/<digest>/` inside one Paperclip-owned provider home. No symlinks/hardlinks into host caches.
- Wrapper links are derived from the runtime name's path depth and repository digest. Explicit task skill input/read tools resolve the original repository entrypoint, rather than assuming `bundle.rootPath/SKILL.md` for a repository skill.
- Retention, remote asset inventory/root rewriting, rehydration and read-only authority use `nativeRuntimeContextAssets`; repository roots are pinned and granted only to the exact authorized run.

- [ ] Red/green: two wrappers reach sibling content and scripts through one physical repository; nested names/Unicode policy paths and explicit skill invocation work.
- [ ] Red/green: remote materialization counts one repository transfer, rewrites both references to the realized root, and obeys confinement while rejecting traversal, collisions and links.
- [ ] Cover source/destination corruption independently, missing/extra files and equal-size restored-mtime edits. Keep Windows ACL/read-only behavior and POSIX mode checks.
- [ ] Implement atomic fresh-home publication, bounded file work and cleanup that drains in-flight operations; preserve an existing saved home on failure.
- [ ] Verify all new native consumers or explicitly preserve their old-layout path. Commit this materialization slice.

## Task 4 — Compatibility, qualification and measured acceptance

**Files:** native execution compatibility/provider-pack registries; native runtime retention/recovery tests; `server/scripts/benchmark-native-skill-preparation.ts` or a narrowly owned standalone shared-skill acceptance script; subsystem docs and an anonymized benchmark report.

- [ ] Add old-layout saved/new-code resumed fixtures; saved contexts keep exact digests and versions. Include deploy-during-staging/turn and legacy fallback cases.
- [ ] Gate emission by the qualified v12 transport/runner pair; unsupported layouts return a permanent named compatibility failure without deleting saved sessions or retrying forever.
- [ ] Prove physical repository copies and transferred bytes drop with 2/4 selected entrypoints from one snapshot. Report logical assigned bytes, unique staged bytes, copies and integrity reads separately.
- [ ] Run affected tests and `pnpm verify`; exit 2 requires focused tests plus applicable CI, not an automatic full local suite.
- Deferred outside the Linux scope: qualify native Codex on physical Windows filesystems. Retain the historical attempt and report its failure without treating it as Linux acceptance.
- [ ] Run the equivalent isolated Linux proof on its native filesystem, using a copied backup and separate port; retain authenticated/private mode and existing credential scope.
- [ ] Integration check against local develop preserves its pool/v11 parser and active saved states. No cutover to the live instance before qualification.
- [ ] Run a fresh whole-change review, address findings, and complete relevant final-revision CI. Prepare the upstream PR with all template sections; report any external platform gate honestly. Do not fold unrelated Windows/pool history into the feature diff.

## Execution method and approval

The user approved the design and instructed execution on 2026-11-17. Use native
implementation in this session with one independent whole-change review. No
second plan-approval pause; ordinary implementation choices remain with the
implementer. A change in live rollout or agent-migration scope requires separate
explicit authorization.
