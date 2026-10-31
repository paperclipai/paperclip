# Project environment selection

## Outcome and delivery

Tasks use their project's saved execution environment, including Daytona resource
configuration. Deliver one reviewed PR with passing checks. After that PR is
ready, create the requested `Daytona Paperclip Coding` environment with a 30 GiB
disk on the user's staging instance. Configuration creation and deployment of
the PR are separate states and must be reported accurately.

## Owning contracts

- Project settings store an environment reference in the existing
  `executionWorkspacePolicy.environmentId` field. Resource sizes stay on the
  referenced environment. No new schema or migration is needed.
- Environment selection belongs to the shared execution policy and heartbeat
  environment-selection module. The task's organizational project supplies this
  default independently of the project supplying its files or checkout settings.
- Priority: explicit low-trust task environment, task project, agent, instance,
  local fallback. Managed-only and forced Kubernetes restrictions still apply.
- External personal-assistant controllers retain their existing placement.
- Existing admitted runs keep their recorded runtime and recovery obligations.
  New admissions use the current project choice; old disks are not resized.
- Daytona owns image/snapshot resource semantics. Image creation forwards the
  selected disk size. A snapshot uses its captured allocation.

## Acceptance matrix

| Journey/state | Required evidence |
| --- | --- |
| Save and reload a project environment | Real project API persistence and visible UI selection; no checkout feature dependency |
| Project overrides agent and instance | Resolver regression and assembled heartbeat dispatch/lease evidence |
| Project has no codebase or uses another project's files | Task project's environment still wins |
| Clear selection, missing project, projectless work | Existing agent/instance fallback remains |
| Low-trust, managed-only, forced Kubernetes | Existing restrictions win; invalid choices cannot cause local fallback |
| Archived/deleted/unbound environment | Existing validation rejects it; selection does not silently change targets |
| Daytona image provisioning | Production provider receives the project's config; live provider reports 30 GiB and command executes there |
| Snapshot provisioning | Overrides are not falsely claimed to resize a snapshot |
| Recovery and environment changes | Existing admission/lease ownership remains effective; no replay or data loss |

## Feedback and verification

First reproduce the ignored project selection with targeted resolver and
PostgreSQL-backed selection tests. Then exercise persistence and assembled
heartbeat dispatch, UI save/clear states, Daytona provisioning and live provider
execution. Run token/map checks and the required repo typecheck, test and build
gates before PR handoff. Preserve failed attempts and report any unverified
boundary. Keep private credentials, tenant identifiers and live evidence out of
public fixtures and the PR description.

## Progress

- Confirmed existing resource schema and unused project environment selection.
- Dedicated branch: `codex/project-environment-selection`.
- Reproduced ignored project placement and hidden UI with failing regressions.
- Found and fixed the project parser dropping environment references on reads.
- Resolver, UI, API, simulated Daytona resource/lease and real local process
  coverage pass. The process cases cover disabled/enabled checkout policy,
  another project's files, and clearing to agent inheritance on a new task.
- Repository typecheck, build, map, module boundary and UI token checks pass.
  A full local test attempt was stopped after the branch rebase to avoid
  claiming mixed-revision proof. Comprehensive validation runs in current-head CI.
- A live 30 GiB create reached Daytona and was rejected by the credential's
  organization-level 10 GiB per-sandbox cap. A read confirmed no allocation was
  left behind. This does not establish that the user's hosted instance has the
  same Daytona account or limit. Live 30 GiB qualification remains blocked by
  that external cap; the configured-resource tests use a simulated SDK boundary.
- The actual browser save/reload/clear walkthrough passed with isolation off;
  independent API reads confirmed the saved and cleared states.
- PR: https://github.com/paperclipai/paperclip/pull/18176.
- Review regressions reproduced eight failures, then passed after preserving
  inherited checkout settings, restoring admitted environment leases, requiring
  project workspace-write authority and checking company bindings. Expanded
  runtime, lease, route and UI integration checks pass (293 tests); native-session
  controls pass (977 tests). Route guard fixtures now model the required permission
  and company-binding lookup and pass all seven cases. Typecheck and build pass
  again after the review fixes.

- A second review caught the creation-time permission context. Both local and
  cloud administrator cases reproduced a 403 using the real authorization
  service. Creation now checks the underlying assignment grant without an
  existing project; updates retain project workspace policy enforcement. The
  20-case route suite passes, as do the seven selection guards. Server typecheck
  and build pass after this correction.

- Final repository review follow-ups: unrelated policy edits no longer revalidate
  an unchanged archived target; unresolved environment reads preserve the saved
  selection without a false unavailable warning; the acquisition helper requires
  and explicitly forwards the atomic binding guard. Both behavior regressions
  were red first. The focused set passes 84 cases, with the 21 route cases rerun
  using a 60-second cold-import budget after a busy-host timeout. Full typecheck,
  build and token/map checks pass.

- A final failure-state regression proves a saved environment can be cleared
  after its list request fails. Loading still disables selection; a failed read
  allows inheritance and shows the list error. All 11 component cases, UI
  typecheck/build and token gates pass after reproducing the blocked clear.
