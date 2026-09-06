/**
 * Sprite-state derivation for the HDO-76 pixel strip prototype.
 *
 * The state mapping is **the** truth-seam of this plugin. It takes
 * persisted runtime state only — issue status, current assignee,
 * agent heartbeat status, and the existence of pending
 * `ask_user_questions` / `request_confirmation` interactions — and
 * maps it onto the archived HuiDots Pixel-Company visual authority:
 *
 *   working        -> WORKING          (blue)
 *   waiting        -> WAITING          (amber)
 *   blocked        -> BLOCKED          (red)
 *   decision_ready -> DECISION_READY   (violet)
 *   idle           -> IDLE             (green / neutral)
 *
 * No timer-derived activity is inferred. The strip is a read-only
 * mirror of persisted state — same source the Board, Active Runs,
 * and Agent detail pages already read.
 */

export type PixelSpriteState =
  | "working"
  | "waiting"
  | "blocked"
  | "decision_ready"
  | "idle";

export type IssueLifecycleStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type AgentHeartbeatStatus = "active" | "idle" | "paused" | "errored";

export interface IssueRuntimeSnapshot {
  readonly id: string;
  readonly status: IssueLifecycleStatus;
  readonly assigneeAgentId: string | null;
  readonly hasActiveHeartbeat: boolean;
  readonly pendingInteraction: "ask_user_questions" | "request_confirmation" | null;
}

export interface AgentRuntimeSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly heartbeatStatus: AgentHeartbeatStatus;
}

export interface ProjectIssueIndex {
  readonly projectId: string;
  readonly issues: readonly IssueRuntimeSnapshot[];
}

const ACTIVE_RUN_STATUSES: ReadonlySet<IssueLifecycleStatus> = new Set<IssueLifecycleStatus>([
  "todo",
  "in_progress",
  "in_review",
]);

/**
 * Map a single issue to a sprite state.
 *
 * The mapping is deterministic and depends only on the persisted issue
 * snapshot. It never reads the wall-clock or any derived timing.
 */
export function deriveSpriteStateFromIssue(
  issue: IssueRuntimeSnapshot,
): PixelSpriteState {
  if (issue.status === "done" || issue.status === "cancelled") {
    return "idle";
  }
  if (issue.pendingInteraction !== null) {
    return "decision_ready";
  }
  if (issue.status === "blocked") {
    return "blocked";
  }
  if (issue.status === "in_review") {
    return "waiting";
  }
  if (issue.hasActiveHeartbeat && ACTIVE_RUN_STATUSES.has(issue.status)) {
    return "working";
  }
  return "idle";
}

/**
 * Map a (projectId, agentId) pair to a sprite state using only the
 * persisted issue snapshots for that project.
 *
 * If the agent has no current issue in the project, the agent is
 * "idle" — the strip never invents work for an agent.
 */
export function deriveSpriteStateForAgent(
  index: ProjectIssueIndex,
  agentId: string,
): PixelSpriteState {
  const ownedIssues = index.issues.filter((issue) => issue.assigneeAgentId === agentId);
  if (ownedIssues.length === 0) {
    return "idle";
  }
  // Pick the highest-priority state across all of the agent's issues
  // for this project. The priority order is:
  //   decision_ready > blocked > waiting > working > idle.
  let priority: PixelSpriteState = "idle";
  for (const issue of ownedIssues) {
    const state = deriveSpriteStateFromIssue(issue);
    if (state === "decision_ready") return "decision_ready";
    if (state === "blocked") {
      // `decision_ready` is already handled above; any other priority
      // here is bumped to `blocked`.
      priority = "blocked";
      continue;
    }
    if (priority === "blocked") continue;
    if (state === "waiting") {
      priority = "waiting";
      continue;
    }
    if (priority === "waiting") continue;
    if (state === "working") {
      priority = "working";
      continue;
    }
  }
  return priority;
}

/**
 * Build the per-project sprite strip from persisted runtime state.
 *
 * The strip lists, in stable order:
 *   - one sprite per agent that has a non-idle state in the project,
 *   - followed by one sprite per agent that is idle but has an
 *     `active` heartbeat status (recently present on the platform).
 *
 * No timer-derived activity is computed.
 */
export function buildPixelStrip(
  index: ProjectIssueIndex,
  agents: readonly AgentRuntimeSnapshot[],
): { agentId: string; state: PixelSpriteState }[] {
  const working: { agentId: string; state: PixelSpriteState }[] = [];
  const idle: { agentId: string; state: PixelSpriteState }[] = [];
  for (const agent of agents) {
    const state = deriveSpriteStateForAgent(index, agent.id);
    if (state === "idle") {
      // Idle agents are only included when their persisted heartbeat
      // status is `active` — that is, the agent is currently online
      // and may pick up work in this project shortly. There is no
      // timer inference here: `active` is a persisted status field
      // the platform already tracks.
      if (agent.heartbeatStatus === "active") {
        idle.push({ agentId: agent.id, state: "idle" });
      }
      continue;
    }
    working.push({ agentId: agent.id, state });
  }
  // Stable, deterministic order: agentId ascending.
  const sortByAgentId = (
    a: { agentId: string; state: PixelSpriteState },
    b: { agentId: string; state: PixelSpriteState },
  ) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0);
  working.sort(sortByAgentId);
  idle.sort(sortByAgentId);
  return [...working, ...idle];
}

/**
 * The human-readable label and the semantic token name for a sprite
 * state. The label maps to the archived Pixel-Company visual
 * authority; the token is the Paperclip UI semantic token the UI
 * layer should consume (the UI honours the token-only rule).
 */
export function spriteStateLabel(state: PixelSpriteState): {
  readonly label: string;
  readonly token: "verified" | "working" | "waiting" | "blocked" | "owner-gate";
} {
  switch (state) {
    case "working":
      return { label: "WORKING", token: "working" };
    case "waiting":
      return { label: "WAITING", token: "waiting" };
    case "blocked":
      return { label: "BLOCKED", token: "blocked" };
    case "decision_ready":
      return { label: "DECISION_READY", token: "owner-gate" };
    case "idle":
      return { label: "IDLE", token: "verified" };
  }
}
