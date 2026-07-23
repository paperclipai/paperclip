# SSH sync-back staging filesystem

## Context

SSH workspace restore downloads and fully extracts a remote tar before replacing
the local workspace. That safety boundary prevents a failed transfer from
destroying active local work, but the extraction directory was created under
`os.tmpdir()`. On the Lucentworks host, `/tmp` has a roughly 5.01 GB per-user
quota; a 4.74 GB workspace therefore consumed nearly the entire allowance and
caused unrelated writes to fail with `EDQUOT`.

Baseline-aware restores also allocated an outer merge stage and then called the
general restore helper, which allocated an inner extraction stage. That path
temporarily required two full snapshot copies before merge.

## Options

1. Continue using `/tmp` and reject restores based on a size/free-space preflight.
   This avoids quota exhaustion but makes otherwise healthy large restores fail.
2. Stream directly into the destination workspace. This removes staging capacity
   but exposes active work to partial replacement when SSH or tar fails.
3. Create one stage beside the destination workspace, reuse it for baseline
   merge, and admit the transfer only after checking the stage filesystem. This
   retains failure isolation, removes double staging, and charges extraction to
   the workspace filesystem rather than the shared temporary-files quota.

## Decision

Choose option 3. Every full sync-back staging directory is created as a uniquely
named sibling of its destination (`.paperclip-ssh-sync-back-*`). Direct restores
own one stage; baseline-merge restores pass their existing stage into the
transfer helper, eliminating the nested copy. Existing `finally` cleanup removes
owned staging after success and failure.

Before spawning SSH or tar, the restore probes the remote snapshot with `du`,
checks free blocks on the selected staging filesystem with `statfs`, and requires
the estimated snapshot size plus the greater of 10% or 512 MiB headroom. A
missing size probe or insufficient capacity fails before transfer and leaves the
destination untouched.

This is a **Build for change** seam: allocation is centralized in
`createSshSyncBackStagingDir`, so a future configurable staging volume or
capacity admission policy does not need to alter transfer logic.

## Consequences and blast radius

- **Blast radius:** SSH sync-back only. Upload staging, small SSH auth files, git
  bundle staging, local runtimes, and non-SSH workspace providers are unchanged.
- A restore now consumes one temporary snapshot on the workspace filesystem.
  The destination's parent must be writable and have enough free space for the
  staged snapshot plus safety headroom.
- Remotes must support the existing `du -sk` probe. Failing closed when size
  cannot be measured trades compatibility with unusually minimal remotes for
  predictable capacity admission.
- The destination remains untouched until extraction completes, preserving active
  work on transport or extraction failure.
- Cleanup remains best-effort in `finally`. A process-level hard kill can still
  leave a uniquely named sibling, as it could previously leave data in `/tmp`;
  stale-directory scavenging is separate operational hardening.
- No credentials or transfer contents are added to process arguments or logs.

## Verification

The bounded regression checks prove that the allocator selects the workspace
parent, insufficient capacity is rejected with the required headroom, and
integration restores remove workspace-local staging after successful, failed,
and baseline-merge transfers. Existing SSH round-trip tests continue to prove
staged content reaches the destination only after complete extraction.

## Rollback path

Revert the capacity assertion and optional caller-owned `stagingDir`, then revert
the allocator call sites to `fs.mkdtemp(path.join(os.tmpdir(),
"paperclip-ssh-sync-back-"))`. This is a code-only rollback with no data
migration, but it reintroduces both nested staging and the `/tmp` quota failure;
use it only while SSH restores are disabled or constrained below the host quota.
