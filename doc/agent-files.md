# Persistent agent files

Each managed agent has one current directory, scoped by company and agent. The
Instructions Editor reads and writes this directory. `AGENTS.md` (or the
configured entry) is one file in it. Agents may create ordinary files and nested
folders for notes, memory, and other personal working material. Files in the
task working directory remain task files.

Agents can edit their own managed files under the responsible user’s current
target permissions. Access to another agent’s files additionally requires the
caller’s own target-scoped configuration permission; shared company membership
or a responsible user alone does not grant peer access.

## Layout

The canonical host directory keeps its existing physical location:

```
<instance>/companies/<company>/agents/<agent>/
  instructions/                 current agent files (editor)
    AGENTS.md
    notes/
    any-supported-file
  file-sync/                   controller-only operational state
    adopted.json
    runs/<run>/live/           isolated writable copy while a run executes
```

The process starts in its existing task workspace. `AGENT_HOME` points to the
registered writable agent copy. Adapter `HOME` and `CODEX_HOME` keep their
existing meanings and are not personal-file storage. Local copies are outside
the task workspace. Remote providers currently confine file sync to their
workspace: their independent agent copy therefore lives under the excluded
`.paperclip-runtime/agent-files/<agent>/<run>/` area. It is not included in task
workspace sync, Git staging, or task deliverables.

Regular files (including binary bytes) and directories are supported, up to
100,000 entries (files and folders), 256 MiB per file and 2 GiB total. Symlinks,
hardlinks, and special
files are rejected, rather than followed or silently skipped. The instruction
entry remains valid UTF-8, at most 1 MiB, and cannot be deleted. The editor edits
text up to 1 MiB and offers downloads for binary or larger files. The reserved
`.paperclip-runtime` directory and the compatibility-only virtual file
`promptTemplate.legacy.md` are not user storage. Task cache and Git ignore
exclusions do not apply to this directory.

These storage limits are separate from the 1 MiB instruction/editor limit. Large
files are hashed and downloaded as streams; listings bound concurrent reads,
and only editor-sized text is buffered. Storage counts uncompressed file bytes,
not allocated disk
blocks. These are sync validation limits, not live filesystem quotas: an agent
can write beyond them while running. Storage limits never pause an agent, fail
a provider run, or block future task admission. A folder at or above a limit
produces a warning on each run until enough files have been removed or shrunk.
Existing saved files are restored even when already over quota, so the agent
can continue working and clean them up with ordinary filesystem tools. Unsafe
paths and links still fail validation; bypassing a storage quota does not
bypass those checks.

An API save above a storage limit returns 422 without changing the saved files.
If a stopped run exceeds a storage limit, none of its agent-folder changes are
saved. The run shows a nonblocking storage warning and its save receipt reports
`AGENT_FILES_LIMIT_EXCEEDED` with the specific limit
and, for an oversized file, its path. The previous saved folder is used on the
next run. The temporary run copy is discarded, including on a limit failure;
there is no retained recovery archive or partial-save option. Transient sync
failures get up to three attempts at the stop boundary before cleanup and an
explicit failure receipt. Individual file writes are atomic, but an I/O failure
partway through a sync can leave some files updated; a failed receipt does not
claim whole-folder success.

Sync failures are diagnostics for the affected run, not errors on the current
files in the Instructions Editor. Historical failures remain in the run log;
the run detail also shows warnings from its save receipt. The editor only shows
preserved instruction-only candidates that may need review, alongside errors
from the current browser edit. Later successful saves do not erase run history.

Larger folders take longer to hash, copy, and transfer on each run. There is one
canonical folder plus temporary working copies for currently active runs (and
remote staging when the transport needs it). No additional captured tree is
created. After verified provider retirement and collection, runs remove their
private trees and baseline metadata, keeping only a small receipt. A successful
warm turn can retain its unchanged copy with the still-running provider. Restart
recovery retries interrupted cleanup without
removing a running provider's files. These are not aggregate disk quotas; the
operator still provisions storage for agents and the configured run concurrency.

## Run lifecycle

1. Under the agent lock, restore current files into a private run copy and save
   a baseline of paths, kinds, modes, and hashes. This is sync metadata, not a
   revision history.
2. Stage the copy through the existing workspace transport. Point `AGENT_HOME`
   and instruction guidance at that registered root.
3. At the provider's verified checkpoint-and-stop boundary, retrieve the entire
   directory into the existing working copy before releasing its environment.
4. Recheck the responsible user's current authorization. Under the same agent
   lock used by editor writes, apply only files changed or deleted relative to
   the starting baseline. For a competing edit or deletion of the same file,
   the last synchronization to acquire the lock wins. Unchanged files do not
   overwrite another run's changes; newly added unrelated files survive.
5. Record the outcome and remove temporary copies for successful and failed
   runs. No per-run file versions, conflict copies, or review queue accumulate.
   The next run starts with the current directory.

A successful warm turn may retain its complete, unchanged materialized directory
and the exact `AGENT_HOME` root with the same provider process. A bounded read-only
probe must verify the full baseline and root identity without unsafe paths or
concurrent changes. Local hashing runs in an isolated child; remote observation
runs at the registered remote root. A failed or uncertain probe requires stopped
collection. The next authorized run claims that same materialization within the
company, agent, workspace, environment and configuration scope. Projectless runs
use the stable workspace descriptor (cwd, repository URL/ref and branch), rather
than the per-run workspace placeholder. A remote handoff verifies both DB leases
belong to the same company, environment and provider allocation, then binds the
successor run's active lease and collector without re-uploading the host mirror.
Heartbeat explicitly permits a collection-only successor handoff before checking
warm reuse. A changed or uncertain directory records durable `retirementRequired`;
that receipt cannot authorize reuse. The successor capability is installed only
after the ownership transaction commits. Configuration changes and abandoned
preparation then stop the provider and collect through that current capability,
never an expired prior lease. Ordinary adoption remains unchanged-only. Failed
authorization or lease validation retires the prior owner without borrowing an
unverified successor; if its lease is unusable, the bytes remain pending.
Before initial admission, the remote transfer's two empty scratch directories are
removed with exact-path, identity-checked `rmdir` operations. Any content, link or
uncertain identity fails preparation; the complete probe never excludes them.
An exact recorded lease that is missing or no longer matches the run/environment
blocks retrieval as well as deletion. Legacy receipts without a lease ID require
exactly one company/run/environment lease, including when a transport is still
cached. Missing or ambiguous ownership preserves pending files without remote
commands. No SSH exception bypasses this fence, and no-ID receipts grant no warm
adoption authority.
The original materialization root remains unchanged. The prior run
loses collection authority; stale cleanup cannot remove the current owner's root.

Edits, additions, removals or changed configuration retire the owner before
collection and fresh preparation. A configuration or copy change found at the
final dispatch fence fails that run after retirement; it does not replay the
request automatically. Idle expiry, restart and abandoned preparation also retire
before collection. Immediate collection retries have a fixed call budget and must
advance; a deferred ownership state ends the callback without inventing attempts.
A failed close leaves an unstopped pending receipt through generic run cleanup.
Later owner retirement or independent current-run stop proof can still collect it;
a prior run's stop proof cannot authorize collection. The whole-directory contract
closes the provider process,
including child processes, to establish this safe collection boundary. It
preserves the provider's resumable conversation. Only the loaded instruction entry
participates in the new runtime instruction digest; adding or editing another file does not change
that digest. Relative supporting files are read from `AGENT_HOME`, not from the
read-only prompt snapshot.

The editor supplies the hash of the file it read. A stale browser save returns
409 and retains the user's unsaved draft. Run synchronization itself uses
per-file last-sync-wins: a later run can overwrite a saved browser edit to the
same file. There is no text merge or historical copy to recover the overwritten
version. Ordinary task files continue using their existing workspace contract.

## Upgrade and recovery

Migration 0287 creates the preview tables idempotently after master’s 0285/0286.
Existing preview receipts, rows, constraints, and pending captures are retained.
On first use, while holding
the agent row lock, import any deployed revision heads into the existing managed
directory once. A controller-owned marker outside agent files prevents any
later replay of those heads. Existing revision rows remain readable for recovery;
new saves never append to them. Old UUID-based clients receive content tokens
and can still submit their previously recorded revision IDs, which are checked
against the corresponding bytes before a write.

Working-copy receipts and native runtime inputs record the new file contract.
A restored native session with no contract field keeps the old instruction-only
copy shape, prompt digest, paths, and collector. Its writes use the compatibility
bridge into current files, with the original baseline fence. Existing pending
legacy candidates remain resolvable. Neither old task workspaces nor arbitrary
external instruction roots are imported as agent directories.

Stock-agent and plugin resets update their declared files while retaining unrelated
personal files and formerly configured entries. Automatic stock upgrades first
record baseline hashes in the existing resource binding, then apply and finalize
under the agent lock. A failed file write or database commit retries against
those hashes and already-applied bytes. Removed, unchanged stock files are
removed; intervening personal edits stop the retry. This pending operation
metadata is cleared on success and does not retain file revisions.

External bundles retain their existing behavior. Their migration to managed
storage is an explicit configuration action. Historical task cwd, provider-home,
checkpoint, and workspace restoration formats are not rewritten.

Backups must include the persistent instance filesystem as well as the database.
New current-file bytes are not database revision rows. Old instruction-only
candidates are retained solely for upgrade compatibility.

Crash recovery can collect a stopped working copy without starting a model.
Missing stop proof or lost remote bytes produce a visible diagnostic, never a
save receipt. An interrupted apply can replay its changed files with the same
last-sync-wins rule. Cleanup resumes for terminal runs; no copy is retained as
an archive after cleanup succeeds.

An unchanged-turn observation is neither a save nor proof that a provider stopped.
If retirement fails, the controller records unresolved ownership and preserves
the materialized root. A crash after ownership transfer can leave the new run
without independently recorded stop proof; terminal run status or the old run's
alias is not enough to collect that root. Recovery leaves it preserved until the
required proof is available. Exact destruction of the current owner's remote
allocation permits an explicit unavailable/no-save outcome and owned local
cleanup. A stopped-but-retained allocation instead stays pending with its files
preserved. The current remote execute API may restart a stopped sandbox even
when it bypasses a persistent session, so recovery cannot use it for retrieval
or deletion. Safe retrieval from a stopped allocation remains a transport gap;
live owner retirement still collects before the environment stops. No save is
claimed for the pending case, and stale prior-run leases cannot authorize cleanup.

## Verification

`agent-directory-working-copies.test.ts` exercises nested/binary files, directory
isolation, last-sync-wins edits and deletions, terminal cleanup, link rejection, old-head
adoption, stable prompt digests, warm ownership transfer, concurrent stale claims,
and stop-proved recovery. `agent-directory-probe.test.ts` covers stable snapshots,
unsafe paths, mutation races and bounded child failures; composed native executor
tests cover retained roots and retirement before collection. The legacy
working-copy and native-tool suites exercise compatibility. Workspace merge tests exercise preflight and
interrupted replay.

The explicit Product E2E `instruction-persistence` suite creates a file through
the browser editor, runs an agent that changes instructions and supporting files,
checks exact binary bytes via the public download route, restarts the server,
and asks a fresh task to prove restored contents using an independent nonce. A
third task edits its entry while the browser saves that same file; the later
run sync wins while a separate browser-created file survives, with no conflict
candidate or manual resolution. Three more tasks save a sparse file at its
256 MiB boundary, exceed that boundary with a nonfatal save rejection, then
remove it and save a new small file. All tasks must succeed, with warnings
visible in run details while full and cleared after cleanup.
Run results, including unavailable credentials, must be reported separately from
unit or matcher results; a passing matcher does not prove a live run.
