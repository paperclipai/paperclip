# Staging failures vs chaos-harness coverage (2026-11-09 00:00Z to 2026-11-11 00:05Z)

Question from Dotta: what failed on `paperclip.staging.paperclip.app` in the last 48 hours, why
did the restart-chaos harness (`tests/restart-chaos/`) not find it first, and what must the harness
add so it would.

## Answer first

1. **276 runs failed, were cancelled or were interrupted in 48 hours, across 114 tasks.** At census
   time, 63 of those tasks (55%) were still `blocked`.
2. **Staging is a continuous deploy target.** There were 47 server process starts in 48 hours. 45 of
   them were new Railway deployments: about one deploy every 40 minutes in working hours. Each deploy
   replaces the container, so the new server runs in a **different process space** (host, kernel boot
   and PID namespace) with **newer code**. Remote Daytona sandboxes keep the previous runner.
3. **The harness restarts the same build on the same Mac, at once.** A harness restart keeps the
   process space and has no deployment identity. It is back in seconds. A staging deploy has three
   differences:
   - it sends a graceful SIGTERM, often 1–3 s after a native coordinator claim;
   - the server stays down for 4–7 minutes;
   - it has a new deployment identity.
   
   Native recovery uses the deployment proof (`proveOwnerGone`, `deployment_replaced`), not PID
   proofs. So the process space matters less than first assumed. This was corrected after review.
   The open gap is the long, mid-turn outage, during which the remote Runner is lost (class R
   below). The harness passed D1 8/8 and D5 6/6 on master while staging blocked tasks.
4. **The Daytona matrix does not use the staging workload mix.** Staging runs OpenCode in 66% of
   native runs (1266 of 1917), uses reusable sandboxes (saved epochs up to 5), runs 25 agents and has
   long-lived parent/child task trees. The Daytona matrix runs only `codex,claude` on fresh
   per-run sandboxes, one task tree deep, with waves shorter than one hour.
5. **The harness never builds old saved state.** In the largest class by count, automatic wakes
   failed 99 times in a row on one parent task over 8.5 hours. That needed a workspace shared under a
   policy retired on 2026-11-07, and every wave starts from an empty database. The existing U2 check
   would have failed the task, so grading was not the gap.

## Method and sources (read-only)

Task labels `T01`–`T60` stand in for staging task identifiers, which are instance-local. The census
owner keeps the mapping outside the repository.

- Staging API, GET only, with the operator's existing CLI token loaded into a child process:
  - `/api/health`;
  - `/api/companies/:id/heartbeat-runs` (company and per agent);
  - `/api/heartbeat-runs/:id`;
  - `/api/heartbeat-runs/:id/events`;
  - `/api/issues/:id`, `/runs`, `/activity` and `/recovery-actions`.
  
  One company exists. There were 1917 runs in the window.
- Deploy and restart times: every run record carries `controllerProcess`, with `processStartedAt`,
  `bootId` and the Railway `deploymentId`. The timeline below is built from those fields.
  GitHub has no staging deployment records, because staging deploys from Railway.
- `git log origin/master` for fixes that touch each failure code.
- Window: a failure counts when its run finished at or after 2026-11-09T00:00Z.

### Data the census could not read

- **Sentry and Honeycomb:** no read credentials for staging were available. The only keys are
  ingest/test-config keys. Sentry triage was not run.
- **a PR-review agent runs:** runs from 2026-11-09 00:00–14:52Z are missing. That agent made more than
  1000 runs in the window, and the run list caps at 1000 with no cursor. Other agents are complete.
- **Commit per deploy:** Railway deployment IDs do not map to git SHAs through the API. Only the
  current SHA (`358977454b`, #20649) is visible. "Fixed on master" therefore means "a merged PR
  changes this path". It does not mean the fix was proven live on staging.
- **Brief staging outage:** staging was in a maintenance window, `tenant_app_unavailable`, at about
  00:11Z on 2026-11-11, during the census. That was another deploy. Data read before the window is
  complete.

## Class table

The share column is the share of the 276 failed runs. The "Blocked now" column counts tasks still
blocked at census time.

| Class | Runs | Share | Tasks | Blocked now | Mechanism (root) | Fixed on master? | Why the harness missed it | Proposed scenario |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W: wake loop on a held shared workspace | 103 | 37% | 4 | 1 | A parent shares a legacy execution workspace with a child that stranded a writer hold on Nov 5. The new stall-wake feature (#20098) woke the parent every 10 min. Each wake failed setup with no backoff. T01 had 99 runs from 07:27 to 15:53Z. | **Fixed:** #20273, #20295, #20314 | Fresh database every wave, so there was no legacy shared-workspace state. The feature landed between waves. U2 would have caught the loop. | None (fixed). If needed: K14 from a pre-2026-11-07 build with M1. |
| R: remote recovery refuses after a deploy | 34 | 12% | 32 | **24** | Recovery after a deploy refuses to continue. Codes include `runner_remote_process_identity_unavailable` (9), `native_remote_recovery_lease_mismatch …identity_run_id` (8), `prior_owner_terminal_state_indeterminate` (6), `cleanup_quarantined` (4) and `missing_evidence` (3). 27 of 34 failed within 10 min of a process start. | **Mostly fixed:** `identity_run_id` by #20642, `prior_owner…` by #20677, others by #20639, #20631, #20666, #20662 and #20650. **Open:** `runner_remote_process_identity_unavailable`, where the remote Runner is gone after a 4–7 min mid-turn outage. | Harness restarts come back at once, with no long mid-turn outage. There were no OpenCode cells on Daytona (19 of 34 are OpenCode). No Daytona workload keeps a tool running across the fault. | **K15 redeploy** (implemented). A long-hold and mid-tool variant with sandbox-side Runner log capture is the follow-up. |
| F: finalization and workspace save-back | 24 | 9% | 15 | 8 | A saved result cannot be copied back or restored. Causes: sandbox disk full (ENOSPC in 2 runs), unsafe symlink in the archive, `recovery_receipt_invalid` (7), a stuck "Recovering saved work…" phase (8) and an exhausted finalization budget (3). | **Partly fixed:** #20666 (receipt), #20578 (re-finalize). Nothing for disk full or symlinks. | Workloads write small files. They never fill the sandbox disk and never create symlinks. ST faults hit S3, not the sandbox disk. | **F1 symlink** workload (built; passes on master). **DF1 sandbox disk full** (proposed). |
| E: Daytona capacity outage | 18 | 7% | 13 | 4 | Daytona returned HTTP 502 and the worker hit SIGKILL from 16:36 to 17:02Z on Nov 10. Reusable sandbox resume failed, plus a git clone network failure. | **Mostly recovers:** 8 tasks recovered automatically and bounded retry works. 4 tasks still blocked. | The harness has no environment-provider fault. All faults hit the control plane or S3. | **EP1 environment provider 5xx window** (proposed, not built). |
| U: provider usage limit | 17 | 6% | 12 | 8 | `provider_limit_wait` waits as designed. The ACPX "terminal limit failure" (7) fails the run, where it should wait. | **Open:** ACPX limit classification. | Not a restart class. Provider shims have no usage-limit message. | Add a usage-limit message to PV faults (proposed). |
| P: provider session resume after a deploy | 16 | 6% | 16 | **11** | The runner or provider cannot resume its session after the controller moved. Codes: `PRP provider resume state is unavailable` (5), `runner_harness_state_mismatch` (8) with sub-codes `provider_identity_incomplete`, `resumed_unavailable` and `backup_without_reusable_lease`, plus `ingress_auth_failed` and `run.attach provider_side_effect_pending`. 8 of the 16 are ACPX and 5 are OpenCode. | **Partly fixed:** #20627 (warm backup). `resume state unavailable` is open. | Same as R: same process space, no OpenCode, no reusable warm sandboxes across deploys. | K15 with `--daytona-warm` and `--adapters claude,opencode`. |
| O: other or unclassified native failures | 13 | 5% | 13 | 5 | `native_run_failed` with no classified error (3), ACPX `session.open` rejected (2), `local_runtime_api_listener_unavailable` (2), `tool.resolve provider_tool_call_retired`, a DB query error, and `Object not found`. | **Open:** classification. | Not deploy-correlated (0 of 13 within 10 min). | None. These are product triage items. |
| B: authorization or binding readiness | 13 | 5% | 9 | 3 | `reviewed_chat_execution_binding_not_authorized` (7) and `not_ready` (2), a credential not shared with the responsible user (2), and a skill package still uploading (2). | **Open** | The harness uses one operator. There are no chat bindings, no shared credentials and no skill uploads. | Out of scope for restart chaos. Route to product. |
| L: legacy runtime lost across a deploy | 12 | 4% | 12 | 5 | Legacy (non-native) runs: `process_lost` (5), `Legacy controller lease lost` (4), graceful SIGTERM (1) and `lease_released_before_terminal` (2). | **Recovers in most cases:** 7 of 12 tasks recovered. | The matrix runs native adapters only. | K15 with a legacy adapter cell (proposed). |
| X: expected cancellations | 11 | 4% | 9 | 2 | Reassignment, ownership changes, dependency blocks and operator interrupts. | No fix needed | n/a | none |
| A: runner or provider-pack artifact incompatible after an upgrade | 8 | 3% | 8 | 4 | New code meets a sandbox prepared by older code. Codes: `OpenCode executable is missing from the provider pack`, `ACPX launch profile omitted its provider-pack authority`, `native_provider_artifacts_admission_unverified` (3), `runner_remote_artifact_platform_mismatch` and `runner_revision_mismatch`. | **Open** | Daytona waves require the runner content to match the image and refuse mismatches. That is exactly the mixed-version state staging lives in. K14 is local only. | **K15 with `--upgrade-from` on Daytona** (allows mixed runner/image versions; proposed follow-up). |
| V: runner event commit stall | 7 | 3% | 5 | 2 | `native_event_replay_conflict: runner_event_commit_stalled`, Codex and ACPX, 20:49–23:55Z on Nov 9. No deploy correlation. | **Likely fixed:** #20385 (usage receipt stalls). No occurrence after 23:55Z on Nov 9. | Database contention (L1) used one-row pressure, not the receipt-update pattern. | none (fixed) |

Totals: 276 runs and 114 tasks. Classes R, P, A and L together are the deploy-crossing failures:
70 runs (25%) and **44 currently blocked tasks**, which is most of the user-visible harm. Class W is
the largest by count but is fixed.

## Deploy timeline (Railway, from run records)

47 process starts between 2026-11-08T22:03Z and 2026-11-10T23:23Z. All but one are new
`deploymentId`s. The exception is a same-deployment restart at 2026-11-09T14:28Z. The median gap in
working hours is about 40 minutes. Every native run longer than about 40 minutes crosses a deploy.

67 of 276 failures (24%) finished within 10 minutes after a process start. In classes R and P, 30 of
50 did. In classes E, O and V, almost none did.

## Per-class detail

### W: wake loop on a held shared workspace (103 runs, fixed)

- Examples: T01 (99 runs), T02, T03 and T04.
- Timeline:
  1. On Nov 5, child T05 failed setup (`workspace_busy`, then `setup_failed`). Its parent
     T01 shared the workspace, a pre-2026-11-07 policy.
  2. On Nov 9, #20098 ("wake the parent once when a child stalls") reached staging. At 07:27Z the
     parent began to be woken about every 10 min by `issue.blocker_stalled_wake`.
  3. Every wake failed with `The workspace still has an unfinished writer or save operation.`
  4. At 15:53Z the parent became `blocked`.
- Fixed by:
  - #20273, which stops stall wakes from failing setup on a held workspace;
  - #20295, which re-proves an exhausted save's agent stop;
  - #20314, which moves stranded legacy subtasks off a parent's held workspace.
- Why the harness missed it:
  - **Old saved state:** every wave starts from an empty database, so a parent/child pair sharing a
    workspace (the legacy policy) never exists.
  - **Missing feature in the tested build:** #20098 landed at 00:26Z on Nov 9, after the last wave
    that had a stalled child.
  - **Timing window:** the loop starts only after a child stalls for longer than the stall threshold.
  - **Grading is not the gap.** The enforced U2 check already fails a task after more than three
    failures with the same code and no status change. The parent would have failed U2 on its fourth
    wake, if a wave had created the legacy state.
- Scenario: none is built in this pass, because the class is fixed and the shared-workspace policy
  is retired for new subtasks. A K14 wave from a pre-2026-11-07 build with M1 would recreate the
  legacy state, if the fix needs regression cover.

### R: remote native recovery refuses after a deploy (34 runs, 24 tasks blocked)

- Examples:
  - T06, T07, T08 and T09 (`lease_mismatch identity_run_id`);
  - T10, T11, T12 and T13 (`identity_unavailable`);
  - T14, T15, T16 and T17 (`prior_owner_terminal_state_indeterminate`, with
    `retirement_refused=journal_commands_unsettled(run.attach.pending | semantic_tool.result.pending)`);
  - T18 and T19 (`cleanup_quarantined`).
- Mechanism, per sub-code. This was corrected after review by the class R fix owner.
  - Native recovery does **not** depend on PID proofs. It uses `proveOwnerGone`, which accepts a
    replaced Railway deployment on an exclusive volume (`deployment_replaced`) or a stopped or fenced
    boot row. The only PID-only caller left is the runtime skill cache lock (#20688).
  - `native_remote_recovery_lease_mismatch … identity_run_id`: the leases were ephemeral and the
    sandboxes fresh, so a reused sandbox was not the cause. This is the shape that #20642 fixed. The
    last staging occurrence was 14:43Z on Nov 10.
  - `prior_owner_terminal_state_indeterminate` with unsettled `run.attach` or `semantic_tool.result`:
    fixed by #20677. Retirement is no longer held when the prior ephemeral sandbox is provably
    destroyed.
  - `runner_remote_process_identity_unavailable` is **still open**:
    1. The controller dies mid-turn while tools run.
    2. Recovery starts 4–7 minutes later.
    3. By then the remote Runner process is gone, or its `session.snapshot` times out.
    
    Why the Runner exits despite its 60-minute connection lease is not yet known.
- Last occurrences: `identity_unavailable` 2026-11-10T08:10Z, `lease_mismatch` 14:43Z, `prior_owner…`
  18:56Z and `cleanup_quarantined` 17:48Z.
- Code pointers:
  - `server/src/services/native-runtime/native-session-executor.ts:14247` (identity wait);
  - `server/src/services/native-runtime/remote-recovery-lease-mismatch.ts`;
  - `server/src/services/heartbeat/restart-interrupted-turn.ts`.
- Why the harness missed it:
  1. **Deploy timing:** a staging deploy sends a graceful SIGTERM, often 1–3 s after
     `native.coordinator.claim`, and the server stays down for 4–7 minutes. K2 restarts at once,
     and K4's long hold uses SIGKILL.
  2. **Missing adapter:** OpenCode (19 of 34) never ran in a Daytona cell.
  3. **Mid-turn Runner loss:** no Daytona workload keeps a tool running across the fault. The
     `tool` trigger covers only the local B5 shell bench, so the remote Runner is never under a
     running tool when the controller goes away.
  4. **Missing environment shape:** `--daytona-reuse-lease` and `--daytona-warm` are not in the
     matrix.
- Scenario: **K15 redeploy** (implemented). The fault does a graceful SIGTERM like K2. The
  replacement then starts in a new emulated process space (a new hostname through a preload, so
  `processSpaceHash` changes) and with a new Railway-shaped deployment identity on the same volume.
  Selected with `--faults K15`. RED wave: see "Harness expansion" below.

### F: finalization and workspace save-back (24 runs, 8 tasks blocked)

- Examples:
  - T20 (`sync_out_retry_exhausted` from disk full, then the finalization budget, three times);
  - T21 (`remote_workspace_archive_unsafe_symlink`);
  - T22, T23 and T24 (`remote_workspace_recovery_receipt_invalid`);
  - T25 and T10 ("Recovering saved work…" phase cancelled with
    `execution_reconciliation_required`);
  - T26, T27 and T28 (07:26Z on Nov 9, right after a deploy).
- Fixed: #20666 (skip unverifiable recovery sources) covers `receipt_invalid`, which last occurred
  at 22:35Z, before that fix was deployed. Disk-full and symlink save-back have no fix and no
  scenario.
- Why the harness missed it: **missing workload.** The workloads write a few KB, never fill the
  sandbox disk and never create symlinks. ST faults break S3, not the sandbox file system.
- Built: the **F1** workload (`--workloads F1`). The agent keeps an absolute symlink to `/etc/hosts`
  in its repository workspace. Wave `w-20261111T012523-s9304` (Daytona, `--storage s3`, K2, Codex
  and OpenCode) passed 2 of 2 on master. The save-back did not block the task. The harness keeps no
  evidence for passing tasks, so it is not verified that the link existed at save-back time.
- Proposed (not built): `DF1`, which fills the sandbox disk to ENOSPC before result copy-back.

### E: Daytona capacity outage (18 runs, mostly self-healing)

- 2026-11-10 16:36–17:02Z:
  - `Daytona sandbox creation failed (HTTP 502)` (10);
  - `Worker process exited (code=null, signal=SIGKILL)` (3);
  - `Reusable sandbox lease … could not be resumed (cause=provider_error | transport_timeout)` (3).
- Plus one `git=network` clone failure and one Daytona rate-limit failure.
- Bounded retry recovered 8 of 13 tasks. 4 remain blocked (T29, T30, T31 and
  T32 are examples).
- Fix #20626 (retry and replace a reusable sandbox that will not resume) shipped before the outage.
  Its effect at this scale is not verified.
- Why the harness missed it: **missing fault type.** There is no environment-provider fault. All
  harness faults hit the control plane, S3 or the provider message stream.
- Proposed: `EP1`, a proxy in front of the Daytona API that returns 502 or times out for a window.

### U: provider usage limit (17 runs)

- `provider_limit_wait` (10) is the designed wait.
- The ACPX "terminal limit failure" (7, an error-triage agent) fails the run. It should wait. This is a product
  classification gap in the ACPX limit mapping.

### P: provider session resume after a deploy (16 runs, 11 tasks blocked)

- Examples:
  - T33, T34, T35 and T25 (`PRP provider resume state is unavailable`);
  - T36, T37, T38 and T39 (`runner_harness_state_mismatch …`);
  - T40 (`run.attach provider_side_effect_pending`).
- Last occurrence: 2026-11-10T21:06Z.
- #20627 (restore a warm backup when its source sandbox is idle) covers `backup_without_reusable_lease`
  and `resumed_unavailable`. `resume state is unavailable` and `provider_identity_incomplete` have no
  fix.
- Why the harness missed it: the same reasons as R, plus ACPX (8) and OpenCode (5) on warm reusable
  sandboxes, which the matrix does not run.

### O: other (13 runs)

- Not deploy-correlated.
- `native_run_failed` without a classified provider error appeared on T41, T42 and
  T43. Those runs reached `run.result.accepted` after two `turn.failed` events.
- ACPX `session.open` was rejected on T44 and T45.
- These are product triage items, not chaos gaps.

### B: authorization or binding readiness (13 runs)

- `reviewed_chat_execution_binding_not_authorized`: 7 runs on a PR-review agent (T30 and T46).
- A credential not shared with the responsible user.
- Skill package uploads still in flight (T47).
- These are product authorization and readiness checks. They are outside the restart-chaos domain.

### L: legacy runtime lost across a deploy (12 runs)

- Examples:
  - `process_lost` on T26, T27 and T48 (07:11Z on Nov 9, three minutes after a
    deploy);
  - `Legacy controller lease lost` on T49, T50, T51 and T52 (08:14–08:19Z on
    Nov 10, 20 minutes after a deploy).
- 7 of 12 tasks recovered.
- The matrix has no legacy adapter cell. K15 could run one, but this was not done in this pass.

### A: artifact incompatible after an upgrade (8 runs)

- Examples: T53 and T54 (`OpenCode executable is missing from the provider pack`), T55
  (`ACPX launch profile omitted …`), T56, T57 and T58
  (`native_provider_artifacts_admission_unverified`), and T59 (`runner_revision_mismatch`).
- Mechanism: a sandbox prepared and admitted by older code is resumed by newer code that expects
  new launch-profile fields or provider-pack contents.
- Why the harness missed it: Daytona waves refuse to run unless the runner content ID equals the
  image (`daytona-image.ts`). This is deliberate, and it excludes exactly this mixed-version state.
- Follow-up: K15 with `--upgrade-from` on Daytona, with the image of the older checkout.

### V: runner event commit stall (7 runs, likely fixed)

- Examples: T60 and T22 (Nov 9, 20:49–23:55Z).
- #20385 (usage receipt stalls during streamed run updates) merged at 23:35Z, and the class has not
  occurred since.

## Harness expansion (this pass)

| Scenario | Classes | Selector | Status |
| --- | --- | --- | --- |
| K15 redeploy into a new process space and deployment identity | R, P, L (and A with `--upgrade-from`) | `--faults K15` | Implemented, unit-tested. Five Daytona waves are recorded below. |
| EP1 environment-provider 5xx window | E | — | Proposed |
| F1 absolute symlink kept in the repository workspace | F (unsafe-symlink save-back) | `--workloads F1` | Implemented, unit-tested. Daytona wave: 2 of 2 pass on master. |
| DF1 sandbox disk full | F (ENOSPC save-back) | — | Proposed |

### Waves on master 8f6ca25976

All waves ran on Daytona image `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:bc7ca92d…`
(runner content `d7e4d82a…`).

| Wave | Args | Result |
| --- | --- | --- |
| `w-20261111T002313-s9301` | `--faults K15 --adapters opencode,claude --workloads A1,C1 --daytona-reuse-lease --concurrency 3 --tasks 6` | 5 of 6 pass. t05 (OpenCode, C1) failed R5 `silent_dead_run`: its run stayed `running` with no event, activity or start evidence for 183 s after the redeploy, then succeeded. No Retry was needed. |
| `w-20261111T004241-s9301` (control) | the same seed and cells with `--faults K2` | 6 of 6 pass |
| `w-20261111T005008-s9302` | `--faults K15 --triggers time,comment --adapters opencode,claude --workloads C1 --daytona-warm --concurrency 4 --tasks 4` | 4 of 4 pass |
| `w-20261111T010000-s9303` | `--faults K15 --adapters opencode --workloads A1,C1 --daytona-reuse-lease --concurrency 4 --tasks 8` | 8 of 8 pass |
| `w-20261111T011044-s9303` (control) | the same seed and cells with `--faults K2` | 8 of 8 pass |

What this shows:

- Under K15, 17 of 18 tasks passed. Under K2 with the same seeds, 14 of 14 passed. The one failure,
  a 183 s silent OpenCode run after a redeploy, occurred only under K15. One failure in 18 is not a
  stable reproduction.
- The staging refusal codes of classes R and P did **not** reproduce on current master with K15
  alone. Examples are `identity_run_id` lease mismatch, `runner_remote_process_identity_unavailable`
  and `prior_owner_terminal_state_indeterminate`. Two explanations remain open:
  - The fixes merged during the window (#20625, #20631, #20639, #20650, #20662, #20666) cover them.
    Staging ran older revisions for most of the window.
  - They need conditions that K15 does not emulate yet:
    - a code change at the deploy, where new server code meets saved state and a sandbox runner from
      the older build (class A);
    - one sandbox reused across different tasks of one agent;
    - many agents and concurrent tasks under load.
- The next scenario to build is **K15 with `--upgrade-from` on Daytona**: start with the older
  checkout and its image, redeploy to the current checkout, and keep the older runner in the
  retained sandboxes. Today the Daytona image check refuses that mixed state on purpose.
