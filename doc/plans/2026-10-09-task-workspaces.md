# Selected architecture — 2026-10-09

This design addresses PAP-171: a short agent turn paid minutes of workspace hydration and copyback because a projectless chat task inherited a large agent fallback directory. It covers app/API and chat tasks, including optional channel defaults, independent project and filesystem choices, explicit physical sharing, and deterministic harness preparation. Two architecture workers received the same full plan and grounding. Both candidates and an independent review used the inherited parent model; this is not cross-model consensus.

## Caller contract first

App/API/chat issue creation supplies typed workspace intent to the same workspace owner. Chat supplies optional defaults and authenticated source context, never paths or credentials. Task creation is transactional and cheap. Run preparation resolves an already-bound workspace or deterministically creates a company/task directory; provider, budget, run ownership and terminal disposition stay with heartbeat. The workspace owner does not become a second heartbeat orchestrator.

Agent tools inspect workspace, discover existing authorized resources, prepare a repository, and explicitly select a workspace. Callers choose intent, never host shell commands or arbitrary destination paths. A repository checkout is optional and never requires a project. Root changes apply only at a safe subsequent admission; existing provider roots are immutable. Ordinary project edits do not move files.

## Synthesis decision

Base A retains issues.executionWorkspaceId as the single active binding and execution-workspace service as the mutation owner. Reject B's replacement binding/realization tables: existing environment leases and native descriptors already own physical and recovery facts. Graft B's narrow provider-facing context, durable settlement by run ID (reload accepted result/source evidence), explicit retention references, atomic repository subtree publication and project-deletion safety. Keep source-project authorization distinct from organizational task project.

Parent scores: A 4/4/4/4/4; B 4/3/4/4/2 on ownership, preserved invariants, origin/tool parity, sync improvement, migration feasibility. Cross-judge independently chose A with the same scores. Neither candidate is implemented unchanged: their broad prepareRun/settleRun facade must not move unrelated execution orchestration into the workspace module.

## State and boundaries

- `issues.executionWorkspaceId`: canonical active binding. Workspace selection/revision and pending intent are typed/versioned task fields, not a second binding. Atomic issue lock/CAS and idempotent mutation receipts protect transitions.
- `execution_workspaces`: filesystem ownership/lifecycle and optional source project. A task-owned workspace has stable company/task identity, independent of agent. Existing rows/paths retain identity. Preserve historical privacy-source intersection. Project deletion cannot cascade needed workspace/recovery state; retain the source policy tombstone or reject deletion until explicit lifecycle cleanup.
- Repository inventory: one company-scoped child table for verified repository identity, relative path, pinned ref/branch, preparation operation/state. No plaintext credentials. Unique contained destination and source intent suppress concurrent duplicate preparation. Resolve symbolic/default ref once; another ref never silently switches a dirty checkout.
- Existing environment orchestration/leases: machine/provider placement and physical ownership. Workspace service asks it to realize selected intent. Reuse sharedWorkspaceKey/canonical paths; same logical ID does not imply same machine. Provider sessions and credentials remain agent/run scoped.
- Existing native sync/descriptors: admitted run baseline, exact source retention, immutable manifests/seeds and durable completion. Generic manifest/transport code stays in adapter-utils. AGENT_HOME retains its separate store and policy.
- Run lifetime and disposition remain owned by heartbeat. Workspace timings wrap actual filesystem work; provider turn is a child interval. Native admission ordering is unchanged: durable ownership/input before corresponding external effects, never reconstruct an admitted root from fresh defaults.
- Routes and runner authority translate/authenticate and call the domain owner. Share validators and generate tool descriptors from the canonical protocol action definitions. No parallel tool-only policy implementation.

## Resolution and transition rules

1. Already-admitted run: use immutable recorded input/recovery evidence.
2. New admission: eligible pending explicit selection, only after prior process and persistence obligations settle.
3. Otherwise current durable binding.
4. Unbound task: explicit selection > eligible parent inheritance > snapshotted resource/endpoint defaults > configured project policy > explicit configured adapter cwd > task directory.

Explicit invalid/unauthorized choices fail with actionable errors, never fall back to home. Existing session cwd becomes a compatibility binding only with verified provenance. No eager scan/copy/migration of legacy homes. Workspace-free providers remain workspace-free. Existing low-trust/native-chat confinement stays authoritative and cannot be relaxed by defaults.

Typed selection vocabulary: task_directory; existing execution workspace; configured project source with shared or managed-isolated policy. Operator cwd compatibility is internal and cannot be submitted by an ordinary agent. New repository paths use existing `.paperclip-repositories/<stable-key>` namespace; existing root checkouts retain their paths.

Source inspection and isolated copies require source-project read access. Writable shared roots additionally require the existing source-project task-assignment authority. The resolved strategy determines sharing: only `git_worktree` creates a separate checkout; an isolated mode label does not exempt a source-root strategy. Board requests use the task's actual assignee when checking scoped grants. Check that authority at selection, task creation, repository mutation, and each new admission; revocation blocks future use without changing already-admitted recovery inputs.

Channel defaults use optional properties (inherit), explicit null (clear), concrete value (override). Resource override beats endpoint. Defaults are captured once at task creation and reauthorized on use. Changing/deleting/revoking configuration cannot relocate existing tasks. Project choice and workspace choice are independent; choosing a source does not silently assign organizational project. Endpoints without configuration work normally.

Active root selection stores pending intent and returns next-normal-admission, without interrupting or scheduling a new model turn. If atomic safe nested acquisition/capture is supported, repository preparation may add a new contained subtree to the active root; otherwise it records preparation for next admission with explicit capability result. Never claim a host-only checkout is available in the running remote environment.

## Sharing and durability

Preserve simultaneous local/SSH tasks in an explicitly configured identical physical folder, including current local/SSH handling of legacy serialize settings. Administrative Git/checkout/restore actions retain target-scoped locks; ordinary provider work is concurrent. Closing one task cannot remove configured shared files or release another participant's resource.

Concurrent remote sharing requires proven common physical placement, separate session authority and coherent snapshot capability. Unsupported new concurrent sharing returns a typed unavailable result; do not instantiate separate clones and label them shared. Already-admitted descriptors remain recoverable unchanged. Local authoritative roots need no replica copyback; SSH retains its actual existing persistence contract.

Sparse filesystem checkpoints use disk-backed full manifests, changed bytes/deletions, safe-link and existing ignore semantics, and separate nested Git history. Capture still enumerates and hashes files with stable-read validation; a metadata hash cache is deferred. No-change sends zero file-content payload where capability is supported; manifest metadata still transfers; unsupported transport uses explicit confined full fallback. Reuse immutable durable seed generations, not only warm sandbox contents; reuse still verifies archive digests. Existing run references pin seeds/deltas until all admitted runs/recovery obligations release them. Retain the final host rescan because the run ownership fence does not exclude external writers to shared folders; do not reuse a stale post-merge manifest.

Seed recovery deliberately uses **no delta chain** in this implementation. An unchanged generation reuses its verified content-addressed immutable full seed; a changed generation creates a fresh full seed. Sparse output transfer is separate from seed recovery. This revises the sketch's 16-delta compaction proposal: composing recovery generations would add a new failure surface before the simpler cache has been qualified. Existing references retain old seeds; no automatic eviction/deletion policy is introduced. Optional cache publication is capped at 16 generations/1 GiB per workspace and 256 generations/256 workspace directories/8 GiB per company. A company-scoped filesystem lock serializes quota checks and publication across workspace roots. Archive and receipt bytes, corrupt entries and abandoned pending generations count against capacity; publication also preserves the manifest storage free-space reserve (256 MiB by default), accounting for a full-copy fallback. Saturation or cache failure skips publication and keeps the already-written per-run recovery seed. Existing over-capacity caches stop growing without deleting admitted evidence. This deliberately trades cache hit rate after saturation for bounded additional storage and unchanged recovery semantics; no global cross-company quota is added. Changed input generations still pay full snapshot creation. New cache entries are reconstructed and checked against the admitted baseline before publication, so concurrent writes cannot label an archive as the wrong generation; this adds cold verification work. A corrupted cache entry remains a miss and falls back to a fresh seed; automatic cache repair and garbage collection are deferred. The existing Git seed contract captures the selected branch/HEAD, not unrelated refs.

Ordinary settlement remains host-durable before successful completion. Preserve export-only recovery and exact-source lease retention. Preserve the specific unsafe-export omission exception and its run-log-only diagnostic. Do not change global merge conflict semantics as a side effect.

## Delivery and ownership

The core implementation owns execution-workspace/task binding schema + shared selection contracts, workspace domain/resolver, issues/heartbeat integration and nullable-project read models. The persistence implementation owns adapter-utils/native sync/trace helpers, exposes integration hooks to core rather than concurrent heartbeat editing. The repository implementation owns acquisition service, inventory schema and routes/runner catalogs, coordinating domain interfaces with core. The integration layer owns channel defaults/config API/UI, documentation, migration generation and final integration/verification. All workers are in the same checkout; do not revert others.

All schema edits land before one centrally generated migration. No handwritten snapshots. Upgrade is additive; old immutable inputs and descriptors remain readable. New selections/checkpoint versions must not be admitted by old controllers: deploy schema first, drain only local test processes if needed, activate new admissions after all serving controllers support them. Rolling back application must disable new admissions, retain new state and finish/recover already-admitted work on compatible controllers; no destructive down migration.

## Acceptance

Targeted tests cover app/chat parity, task directory without Git, reassignment, organization change without relocation, explicit configured-folder concurrency/lifecycle, privacy intersection, repository permission/idempotency/ref conflicts, pending root changes without interruption, accepted-result recovery, unsafe-export exception, old descriptors, and no access to unrelated home contents. Persistence fixtures prove unchanged zero payload and one-file/deletion changes where supported, seed reuse and corrupted/stale fallback. Timings include delayed finalization. UI settings/errors/projectless links work with token-only styling. Run full typecheck/test:run/build before handoff; distinguish fixture proof from unperformed live provider qualification.

## Phase status

- Ground: complete.
- Sketch: complete, A selected with stated grafts.
- Agree: user explicitly chose architecture then implementation; no additional checkpoint.
- Implement: code complete; targeted checks pass, broad-suite qualification remains incomplete (see verification record).
- Scrap: conditional; two repeated boundary workarounds require redesign rather than silent escape hatches.


## Layer plan and public usage

| Layer | Responsibility | Contract |
| --- | --- | --- |
| Shared types and database | Durable task intent, one active binding, optional source project, repository inventory | `TaskWorkspaceSelection`; existing `issues.executionWorkspaceId` |
| Workspace domain | Authorize selection, queue safe transitions, bind stable task folder, retain source privacy | `validateSelection`, `inspectTaskWorkspace`, `selectTaskWorkspace`, `applyPendingTaskWorkspaceSelection` |
| Task creation | Resolve explicit/parent/channel intent without making filesystem side effects | `workspaceSelection` on create; source marked internally |
| Channels | Merge connection/destination defaults, check sender and agent access, snapshot once | `executionDefaults: { projectId?, workspace? }` |
| Repository preparation | Validate repository/ref, authorize credentials, publish contained checkout idempotently | Repository request queues for next normal admission |
| Runner tools | Discover authorized choices and submit intent | Get/list/select workspace; prepare repository |
| Harness | Determine cwd, prepare queued repositories before baseline, enforce trust/placement policy | Existing admission and environment ownership fences |
| Filesystem persistence | Stable manifests, sparse output, verified seed reuse, durable settlement | Backward-readable native descriptors; new descriptor version for nested repositories |
| UI | Optional defaults and projectless workspace navigation | Existing Apps settings and Workspaces surfaces |

Example task creation:

```ts
await issues.create(companyId, {
  title: "Write the report",
  projectId: null,
  workspaceSelection: { kind: "task_directory" },
});
```

A task can later select an authorized existing workspace with its current binding revision and an idempotency key. The response states that the selection applies on the next normal admission; it does not restart the current process. A repository request similarly records preparation intent when the active provider root cannot safely accept a new checkout. Project assignment alone never requests this transition.

Example channel defaults:

```json
{
  "executionDefaults": {
    "projectId": null,
    "workspace": { "kind": "task_directory" }
  }
}
```

A destination may override either field independently. Omitted fields inherit the connection value; `null` clears that field's inherited choice. A cleared workspace choice allows the ordinary project/task resolution path. Changing defaults affects new conversations only. Saving a destination default does not overwrite its independently managed enabled state.

## Verification and rollout limits

Tests must distinguish local fixture proof from live provider qualification. The implementation adds database and protocol tests, compatibility tests for old descriptors, plain-directory and nested-repository persistence fixtures, and sparse/checkpoint/cache tests. A passing fixture does not prove Daytona or SSH production throughput. The original diagnostic run is never interrupted or modified as part of this work.

Deploy schema before admitting the new state. Native descriptor v3 requires compatible recovery controllers; mixed-version controllers must not claim new admissions. Rollback retains the schema and immutable seeds and routes existing v3 obligations to compatible controllers. Do not delete legacy home content, existing workspace directories, or accepted-result recovery evidence.

### Local verification record — 2026-10-09

- Full `pnpm -r typecheck` and `pnpm build` passed. A final direct server `tsc --noEmit` passed after the last server corrections. The full build preceded those final corrections; it was not repeated.
- Generated runner contracts, migration validation, module boundaries, token gates, and `git diff --check` passed.
- Focused checks passed for workspace binding/admission/reopen, concurrent local/SSH sharing, task-folder isolation, channel defaults and email admission, projectless UI, and immutable recovery behavior. Final repository lifecycle batch: 19/19; file browsing: 38/38; sparse checkpoints/cache: 7/7; Git/history: 69/69; tracing: 11/11; executor timing: 2/2.
- `pnpm test:run` was attempted and stopped with exit 130 after roughly an hour of serial server tests and repeated fixture timeouts. Its observed failures were 54 chat cases, one executor timing case, and 23 runtime-service cases. This is **not** a passing full-suite result. The run also began before the final source edits, so it does not qualify the frozen final tree.
- A fresh retry passed 53/54 previously failing chat cases; the remaining Slack admission case exceeded its short asynchronous observation window. After one database-setup timeout, the final isolated retry passed with the original assertions and a larger setup-hook budget (1 passed, 1,145 skipped; `chat-slash-final.log`). Thus all 54 cases passed across fresh retries, not in one clean full run. The executor timing cases both pass in fresh processes. Slow local listener lookups were independently measured at 3.5–6 seconds each; do not interpret the broader runtime failures as proven product regressions or proven baseline failures without further isolation.
- No live SSH/Daytona performance qualification or staging deployment was performed. Clean full-suite qualification on the frozen tree remains a release prerequisite.

Detailed local logs are retained in `/tmp/paperclip-workspace-architect/` (`build.log`, `typecheck-final.log`, `tests.log`, `chat-failures-retry.log`, `repository-lifecycle-tests.log`, and `file-resources-final.log`). Worker verification notes are in `core-progress.md`, `repository-progress.md`, and `sync-progress.md` there.
