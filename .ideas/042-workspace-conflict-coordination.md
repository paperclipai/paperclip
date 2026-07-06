# 042 — Workspace Conflict Coordination for Parallel Agents

## Suggestion

Multiple agents can operate in shared project/execution workspaces
(`execution-workspaces.ts`, `workspace-operations.ts`). But the workspace model only reasons
about conflict at **close** time — `execution-workspaces.ts` computes `blockingReasons` /
`blockingIssues` to decide if a workspace can be destructively closed. There's nothing
coordinating **concurrent edits**: if two agents work the same files in the same workspace at
once, they clobber each other — last-write-wins, lost work, or a corrupted tree. As companies
parallelize work across an engineering team of agents (exactly the scaling story Paperclip
sells), this silent-collision failure mode grows with every agent you add.

Add **workspace conflict coordination**: file/path ownership and soft-locking so parallel agents
don't overwrite each other, with detection and resolution when they collide anyway.

## How it could be achieved

1. **Path-level soft locks.** When an agent's run begins editing a file/subtree, record a claim
   keyed by `{ workspaceId, path, runId, expiresAt }` — reusing the lease pattern already in the
   repo (`environmentLeases`, and proposed for secrets in idea 021). Claims auto-expire on run
   end/TTL so a crashed run never wedges a path forever.
2. **Coordinate, don't just block.** A second agent wanting a claimed path can wait, pick
   different work, or request a handoff (idea 028) — surfaced as a soft signal, not a hard error,
   so agents degrade gracefully instead of failing.
3. **Collision detection.** `workspace-operations.ts` already logs file operations per run;
   detect overlapping writes to the same path across concurrent runs and flag them, even if locks
   were bypassed. A detected collision raises an inbox/review item rather than silently merging.
4. **Ownership zones (coarser option).** Let an operator assign workspace subtrees to teams/agents
   (e.g. marketing-bot owns `/content`, eng owns `/src`) so most parallelism is conflict-free by
   construction — the file-ownership discipline humans use for the same problem.
5. **Compose with admission.** The Fleet Concurrency Governor (idea 001) can factor lock
   contention into scheduling: don't wake an agent whose only available work is fully locked.

## Perceived complexity

**Medium.** The operation log and a reusable lease/claim pattern already exist, so soft-locking
and collision detection are tractable additions rather than new infrastructure. The hard parts
are semantic: locks must be advisory enough not to deadlock autonomous agents (a stuck claim
must always expire), agents must be *told* about claims in a way they actually honor (prompt/tool
surface), and resolution UX for genuine collisions needs care. Start with collision *detection*
from the existing op log (pure visibility, zero risk), then add soft locks and ownership zones.
