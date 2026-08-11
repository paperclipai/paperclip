/**
 * Normalized presentation model for the chat-style task thread (the default
 * task view; the classic legacy view sits behind enableClassicTaskInterface).
 *
 * This is a deliberately small, protocol-agnostic model that the new render
 * layer consumes. Two producers feed it:
 *   1. The dev harness, via synthetic fixtures (task-chat-fixtures.ts).
 *   2. The live thread, via an adapter over the existing comment/run props.
 *
 * Every field traces to a real agent-protocol concept (ACP SessionUpdate /
 * acpx AcpRuntimeEvent / TranscriptEntry). See DESIGN.md and the plan's state
 * inventory for the mapping. No timing/motion values live here — those are
 * CSS motion tokens in ui/src/index.css.
 */
import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import type { IssueThreadInteraction } from "@/lib/issue-thread-interactions";

/** Who authored a thread row — the primary legibility signal. */
export type TaskChatAuthorKind = "human" | "agent" | "system";

/** ACP ToolCallStatus. */
export type TaskChatToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** ACP PermissionOptionKind. */
export type TaskChatApprovalOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

/** ACP PlanEntryStatus. */
export type TaskChatPlanEntryStatus = "pending" | "in_progress" | "completed";

/** ACP PlanEntryPriority. */
export type TaskChatPlanEntryPriority = "high" | "medium" | "low";

export interface TaskChatApprovalOption {
  id: string;
  label: string;
  kind: TaskChatApprovalOptionKind;
}

export interface TaskChatDiff {
  path?: string;
  added: number;
  removed: number;
  /** Optional unified-diff-ish lines for display only. */
  lines?: Array<{ kind: "add" | "remove" | "context"; text: string }>;
}

export interface TaskChatTokenUsage {
  /** ACP UsageUpdate.used — tokens in context. */
  used: number;
  /** ACP UsageUpdate.size — context window size. */
  size: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** A human/agent/system message bubble. */
export interface TaskChatMessageItem {
  id: string;
  kind: "message";
  author: TaskChatAuthorKind;
  authorName?: string;
  text: string;
  timestamp?: string;
  /** Show a streaming cursor and suppress collapse while true. */
  streaming?: boolean;
  /** Optimistic local echo state (matches IssueChatComment.clientStatus). */
  optimistic?: "pending" | "queued";
  /**
   * Per-message mode tag ("Agent mode" / "Plan mode" / "Ask mode"). Shown as a
   * chip in the agent header and under a sent human bubble (v6 decision).
   */
  modeLabel?: string;
  /** Assigned agent icon name (AgentIconName) for the avatar header. */
  agentIcon?: string | null;
  /**
   * Responsible user's display name, set only when this agent comment is a
   * cross-issue write (the author is not the assignee). Renders as a
   * "for {user}" chip beside the author name (the open cross-task write design (attribution)).
   */
  onBehalfOfUserName?: string;
  /**
   * Agent text streamed inside a run turn (interstitial updates between tool
   * calls). Ephemeral in the redesigned view (PAP-361): while streaming it
   * takes the live parent row's line (TaskChatStatusItem.selfTalk); once
   * finished it renders nowhere — the run log / classic transcript remain the
   * archive. Tagged for live and settled transcripts alike.
   */
  interstitial?: boolean;
  /** Epoch ms of the message's first streamed chunk. */
  atMs?: number;
  /**
   * The settled run turn "attached" to this bubble (round 9): when the run's
   * final reply lands, the live parent row transforms into the "Worked · …"
   * summary rendered on this bubble's always-visible timestamp line —
   * "2:34 PM · ✓ Worked · 38s · 3 tools" — instead of a standalone row.
   * Expanding still nests the tool history beneath the bubble.
   */
  attachedTurn?: TaskChatTurnItem;
  /**
   * Structured system-notice fields (PAP-443), carried only for
   * author === "system": the comment's server-authored presentation hints and
   * metadata sections drive the collapsed one-line row + expandable detail.
   */
  presentation?: IssueCommentPresentation | null;
  metadata?: IssueCommentMetadata | null;
  /** Agent that owns the source run, used to build run-detail links in metadata rows. */
  runAgentId?: string | null;
  /** Raw comment timestamp (ISO) — the collapsed system row shows relative time. */
  createdAtIso?: string;
}

/** Collapsed chain-of-thought (ACP agent_thought_chunk). */
export interface TaskChatThinkingItem {
  id: string;
  kind: "thinking";
  lines: string[];
  streaming?: boolean;
  /** When true, render collapsed ("Worked for N") with an expand affordance. */
  collapsed?: boolean;
  /** Human-readable elapsed label for the collapsed header. */
  summaryLabel?: string;
}

/** A tool invocation row (ACP tool_call / tool_call_update). */
export interface TaskChatToolItem {
  id: string;
  kind: "tool";
  name: string;
  /** Raw ACP tool name pre-collapse ("mcp__server__tool") for taxonomy lookup. */
  rawName?: string;
  /** ACP ToolKind. */
  toolKind?: string;
  status: TaskChatToolStatus;
  /**
   * Summarized primary argument (file path, command, pattern…) rendered mono
   * next to the tool name — the v7 toolrow "target".
   */
  target?: string;
  detail?: string;
  diff?: TaskChatDiff;
  /** Resolved permission decision badge, when one applied. */
  decision?: "allowed" | "rejected";
}

/**
 * A lifecycle state rendered as a status affordance — never a bubble.
 * Covers both LIVE (running/working) and Tier-B (awaiting_approval,
 * interrupted, refused, truncated) states.
 */
export interface TaskChatStatusItem {
  id: string;
  kind: "status";
  status:
    | "running"
    | "working"
    | "awaiting_approval"
    | "interrupted"
    | "refused"
    | "truncated";
  label: string;
  detail?: string;
  /** Raw tool name of the in-flight tail tool_call (drives the pill's icon). */
  toolName?: string;
  /**
   * Flattened plain text of the interstitial update currently streaming
   * (PAP-361, round 9): it renders in a dedicated single-line row directly
   * above the status line — a slot PERMANENTLY RESERVED while the turn is
   * live, so the layout above never jumps — inside a one-line viewport
   * showing the streaming tail line; the gerund rotation below runs
   * uninterrupted. When the message finishes the pill HOLDS the text as a
   * static ellipsized line until the next update supersedes it or the turn
   * ends (PAP-368) — nothing persists in the settled thread.
   */
  selfTalk?: string;
  elapsedMs?: number;
  /** Run start epoch ms; live states tick their own elapsed from this. */
  startedAtMs?: number;
  tokens?: TaskChatTokenUsage;
  /** Present for awaiting_approval (ACP RequestPermissionRequest). */
  approval?: { toolName: string; options: TaskChatApprovalOption[] };
}

/** A lifecycle divider (session start, interruption, turn boundary). */
export interface TaskChatMarkerItem {
  id: string;
  kind: "marker";
  variant: "session_start" | "interrupted" | "turn_boundary";
  label: string;
  detail?: string;
}

/** A second-tier live token/cost readout (ACP UsageUpdate). */
export interface TaskChatUsageItem {
  id: string;
  kind: "usage";
  usage: TaskChatTokenUsage;
}

/**
 * The task description rendered as the requester's first chat bubble
 * (PAP-375). A placeholder kind only — the host supplies the render
 * (TaskChatThread binds TaskChatDescriptionBubble to the live issue), mirroring
 * how interaction items defer to renderInteraction. Always prepended AFTER
 * thread assembly, so no backbone entry or settled turn can sort above it.
 */
export interface TaskChatBriefItem {
  id: string;
  kind: "brief";
}

/**
 * An issue-thread interaction (plan confirmation, question card, suggested
 * tasks…) interleaved chronologically into the thread. The payload is the
 * existing control-plane IssueThreadInteraction — the render layer wraps the
 * shared IssueThreadInteractionCard rather than re-modeling the five kinds.
 */
export interface TaskChatInteractionItem {
  id: string;
  kind: "interaction";
  interaction: IssueThreadInteraction;
}

/** Items a turn can group — everything except another turn. */
export type TaskChatTurnChildItem =
  | TaskChatMessageItem
  | TaskChatThinkingItem
  | TaskChatToolItem
  | TaskChatStatusItem
  | TaskChatMarkerItem
  | TaskChatUsageItem;

/**
 * One agent turn's activity (thinking/tools/diffs) grouped so a finished turn
 * can fold into a one-line expandable summary ("✓ Worked · 38s · 3 tools ·
 * +34 −3"). A live turn carrying `liveStatus` renders as a single expandable
 * parent row headed by that status line (gerund/tool-state + elapsed +
 * tokens); expanding nests the chronological activity underneath, and on
 * settle the header morphs in place into the summary. The live → settled
 * fold animates (~ --motion-turn-fold), while turns that load already-settled
 * collapse instantly.
 */
export interface TaskChatTurnItem {
  id: string;
  kind: "turn";
  items: TaskChatTurnChildItem[];
  settled: boolean;
  /**
   * The in-flight run's status line, hoisted to be THE turn's single visible
   * row while collapsed (PAP-354 parent-row model). Absent once settled.
   */
  liveStatus?: TaskChatStatusItem;
  /** Animate the fold when settling (false = collapse instantly, e.g. history). */
  animateFold?: boolean;
  summary: {
    /** e.g. "38s" — omitted when unknown. */
    durationLabel?: string;
    toolCount: number;
    added: number;
    removed: number;
    /** e.g. "12.3k tokens" — omitted when unknown. */
    tokensLabel?: string;
    /** Failed/interrupted turns get a ✗ affordance instead of ✓. */
    failed?: boolean;
  };
}

export type TaskChatItem =
  | TaskChatMessageItem
  | TaskChatThinkingItem
  | TaskChatToolItem
  | TaskChatStatusItem
  | TaskChatMarkerItem
  | TaskChatUsageItem
  | TaskChatInteractionItem
  | TaskChatTurnItem
  | TaskChatBriefItem;

/** A structured plan entry (ACP PlanEntry) for the Plans tab. */
export interface TaskChatPlanEntry {
  id: string;
  content: string;
  status: TaskChatPlanEntryStatus;
  priority: TaskChatPlanEntryPriority;
}

export interface TaskChatPlan {
  /** Revision index (1-based); higher supersedes. */
  revision: number;
  entries: TaskChatPlanEntry[];
  updatedAt?: string;
}
