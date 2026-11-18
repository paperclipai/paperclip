# Shared repository assets for native skills

## Linux scope after Windows downscope

The current contribution targets isolated native Codex on Linux, including WSL.
Native Windows runtime qualification is deferred and is not a release gate for
this Linux scope. Keep saved-context compatibility, source and delivered byte
checks, and portable filesystem fallbacks. The Windows measurements below are
historical evidence, not a native Windows support claim.


Status: approved by the user on 2026-11-17 for implementation. Live agent migration or restart is not part of this approval.

## Problem and measured evidence

Imported repository skills are currently projected as a generated `SKILL.md`
plus the complete pinned repository under `.paperclip-repository/`. Each selected
entrypoint produces another self-contained tree. The package archive is already
shared in durable storage; the version projections, native assets, and provider
skills homes multiply the repository again.

The measured native Codex workload has 13 selected skills, 24,975 files and
295,533,924 logical file bytes. Four skills each include about 63 MB and 5,571
files; four more each include about 11 MB and 671 files. The observed repository
files include application code, specifications and visual test images. This is
filesystem preparation, not a 296 MB prompt.

The completed Windows startup after database recovery took 22m30.587s from run
creation to first tool start. `runtime_context.skills` took 309.711s and
`runner.runtime.stage` took 600.834s. An earlier run with identical asset digests
took 17m21.135s to its first tool. Another attempt measured skills at 171.290s but
was interrupted by a database outage. Load and concurrent recovery differed;
these observations do not establish a consistent startup improvement from the
bounded file-I/O patch. Its smaller 671-file benchmark measures a separate scope.

## Intended result

A fresh native run copies each distinct authorized repository snapshot once,
regardless of how many assigned skills come from it. Ordinary standalone skills
retain their existing self-contained layout. Imported skills retain their exact
version, entrypoint, supporting scripts, and authored relative references.

Warm reuse must still detect changed content, deleted/extra files, substituted
paths and tampered delivered assets. Windows must not switch to timestamp-only
trust. Company authorization, approvals, budgets and audit remain with their
existing owners.

## Approaches and recommendation

1. **Share the pinned repository in the existing native runtime (recommended).**
   Keep one verified repository asset and small per-skill discovery wrappers.
   This removes repeated trees without guessing which authored references matter.
   It requires an explicit runtime contract and provider materializer update.
2. **Restrict every import to its skill folder.** Smaller in the simplest case,
   but arbitrary sibling/shared references and repository scripts would break.
   Explicit dependency manifests could support this later. Do not silently drop
   files from existing pinned versions to get a better benchmark.
3. **Write another runner or force all agents onto one backend.** This leaves
   the importer duplication in place and adds session, tool, recovery and provider
   maintenance. The slow measured run already uses Paperclip Runner with Codex.
   Replacing the runner is not the first repair for this defect.

Hardlinks/junctions to mutable host caches are not the implementation: they retain
duplicated path traversal, introduce shared mutation/ACL risks, and are not a
portable cross-host representation. Do not weaken the existing no-link policy.

## Proposed ownership and contract

### Server preparation

- Keep durable skill/repository versions and their authorization unchanged.
- Resolve selected version metadata before materialization. For a repository
  skill, retain its company-scoped snapshot ID, digest, authored entrypoint and
  optional `agents/openai.yaml` policy instead of eagerly constructing a full
  per-version runtime projection for this native consumer.
- Add an opt-in normalized repository reference to runtime skill discovery; old
  callers keep their existing portable projection. No provider-specific paths in
  `company-skills` or storage services.
- Native context preparation groups repositories by authorized company, snapshot
  and verified content identity. Materialize one canonical asset per group and
  small generated discovery files per assigned skill. Different snapshot versions
  never merge merely because repository URLs match.
- Use existing content-addressed assets, manifests, publication locks, run pins,
  access leases and retention. A new reference is not new authority to read a
  company repository. No authoritative database schema change is expected; if a
  new persisted field is actually needed, follow the migration workflow first.

### Versioned native runtime representation

- Introduce a versioned repository-skill representation with: the existing skill
  identity/version, a common repository asset reference, the authored entrypoint,
  and its small discovery policy/wrapper reference. Standalone skills remain
  expressible with their existing bundle reference.
- The canonical context digest covers skill membership, versions, entrypoints,
  policies and repository digests. Runtime destination paths are derived data.
- Update the owning JSON schema, generated TS/Rust validators, canonical digest
  functions, native execution compatibility and provider-pack contract together.
  Do not silently add fields that old exact-key parsers reject.
- Select the next supported execution schema/capability after inventorying the
  actual current registry. Do not hardcode a guessed version number in this design.

### Provider materialization

- A shared materialization planner owns the layout for qualified native providers.
  Provider drivers supply their discovery/home paths and policy-file needs.
- Inside the provider's Paperclip-owned runtime home, stage repository assets once
  under `repositories/<digest>/`. Keep them outside recursive skill discovery.
- Create each assigned skill under `skills/<runtimeName>/`, with a wrapper whose
  relative link points to the authored entrypoint in that same runtime home.
  Read the original skill relative to its original directory in the shared tree.
  This is a real directory tree, not a symlink or a host-cache dependency.
- Preserve each provider's discovery metadata and policy behavior. Explicit task
  skill inputs and Paperclip skill-read tools must resolve the real entrypoint;
  they must not assume `bundle.rootPath/SKILL.md` for repository skills.
- Validate containment, names, collisions and exact manifest membership before
  publication. Seal the shared repository once using the platform's existing
  protections. Do not grant agents write access to it.
- The server tool authority and provider sandbox must admit the exact pinned
  shared repository root as read-only. Adding the sibling directory must not
  expand reads to other repositories, companies or arbitrary filesystem paths.
- Publish a complete fresh assignment atomically. Failure/cancellation drains
  owned work and leaves a previously published or saved session intact.

### Remote transport and compatibility

- Transport a manifest of unique repository assets plus small skill references.
  Reconstruct the same self-contained runtime home on the remote host. No Windows
  absolute paths or host-only links may cross into a Linux sandbox.
- Test against actual confinement rules, including entrypoint reads outside the
  discovery directory but inside the admitted runtime home.
- Old saved contexts remain readable and executable through their original
  versioned materialization path. Do not rewrite their prompt/context digests or
  repin skills while resuming them. Existing active runs can finish unchanged.
- Emit the new representation only for qualified server/runner/transport pairs.
  An old consumer either receives an explicitly compatible old representation or
  is rejected before launch with a permanent, named compatibility error. Preserve
  saved state; no generic retry loop or automatic destructive reset.
- Legacy adapters remain supported. Their portable projection is an explicit
  fallback in the first native rollout, not a claimed deduplication fix for Legacy.
  Extending the normalized shared planner to a Legacy transport requires its own
  acceptance proof. Do not change agent defaults to hide that distinction.

## Scope and rollout

First qualify native Codex, the measured path, on Windows and Linux. All native
provider materializers must either support the new form through the common
planner or remain explicitly on the compatible old form until qualified.
Preconfigured user-owned homes retain their existing opt-out behavior.

Use a separate isolated instance/port and a copied backup for Linux acceptance.
Keep repositories, runtime assets, credentials and PostgreSQL data on its Linux
filesystem. Do not use `/mnt/c` or `/mnt/d` for this performance comparison.
Do not migrate or restart the live product tasks to run this qualification.

The proposed direction is Paperclip Runner for qualified Linux workloads. Global
agent conversion and a new custom runner are out of scope. Existing Legacy
adapters remain until their tools, authentication, questions, cancellation and
recovery have passed a real per-provider pilot.

## Verification and acceptance

- Red/green fixture: two selected skills from the same pinned repository currently
  deliver two repository copies; the new run stages/transports one plus two wrappers.
  Different versions or unauthorized companies must not share authority.
- Read sibling files/scripts through authored relative references; preserve policy
  metadata, explicit skill invocation, non-ASCII names and provider discovery.
- Reject equal-size edits with restored mtime, missing/extra files, damaged manifests,
  symlink/junction substitution, traversal and conflicting runtime names. Test source
  and delivered snapshot damage independently, including the warm path on Windows.
- Exercise parallel starts, publication races, cleanup/cancellation and retention
  while one run still holds the shared repository. No deletion of an active asset.
- Save old-layout state and resume it with the new code. Exercise a deployment in
  the middle of staging/turn execution; preserve existing sessions and files.
- Prove the reduced physical repository count and transferred bytes, not just a
  cache hit or faster wall clock. Report logical assigned bytes separately from
  unique staged bytes, copies and integrity reads.
- Measure cold and warm whole starts to provider turn, first agent event and first
  tool, with skill and runtime-stage spans. Hold selected versions constant and
  record concurrency/load. Also repeat a real mutation between warm runs.
- Run affected local tests and required CI at the final revision. No claimed speedup
  before an actual comparable native run; no universal latency target inferred from
  the interrupted measurements above.

## Decisions left to the implementer

Exact schema revision/capability name, helper/module splits, provider-specific
discovery paths, bounded I/O scheduling and the minimum representative repository
fixture. Choose these from current contracts, avoiding new global orchestrators,
timer polling and duplicated authorization state. A second database copy or new
credential grant is not part of this design.
