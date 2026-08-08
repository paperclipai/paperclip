import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticNode,
  IssueBlockerDiagnosticsResponse,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  IssueStatus,
  IssueSubtreeDiagnosticNode,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { deriveActiveRecoveryDisplayState } from "./recovery-display";

/**
 * A single, readable answer to: "what moves this task forward next?"
 *
 * Every agent-owned non-terminal task, and every task that blocks another,
 * resolves into EXACTLY ONE of four
 * lanes so the board never has to synthesize an answer from five cards.
 *
 * Resolution priority (spec §2): Working now (an actual run beats everything)
 * → Recovery in flight (a routed recovery is more actionable than the blocker
 * it fixes) → Waiting on a decision → Blocked by real work.
 */
export type NextActionLane =
  | "working_now"
  | "recovery"
  | "waiting_decision"
  | "blocked_real_work"
  | "none";

/** Maps to the left-accent hue. Recovery uses the recovery-display ladder. */
export type NextActionAccent =
  | "in_progress"
  | "in_review"
  | "todo"
  | "blocked"
  | "recovery_amber"
  | "recovery_sky"
  | "recovery_red"
  | "none";

export interface NextActionIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

export interface NextActionOwner {
  label: string;
  kind: "agent" | "user" | "board" | "external" | "system" | "unknown";
}

export type NextActionControlKind =
  | "open_recovery"
  | "assign_worker"
  | "retry_now"
  | "choose_disposition"
  | "open_blocker";

export interface NextActionReference {
  label: string;
  ref: NextActionIssueRef;
  /** Terminal-gate evidence chip, e.g. "gate: workspace_finalize_pending". */
  gate?: string | null;
}

export interface NextActionSummary {
  lane: NextActionLane;
  accent: NextActionAccent;
  /** Uppercase lane chip label. */
  laneLabel: string;
  /** Plain-language answer, kept short (spec: ≤ ~64 chars). */
  statement: string;
  /** Owner + timing/context context line. */
  why: string | null;
  owner: NextActionOwner | null;
  /** At most one primary control; only rendered when we have a deep-link target. */
  primaryControl: { label: string; kind: NextActionControlKind; ref: NextActionIssueRef | null } | null;
  references: NextActionReference[];
  /** Blocked-lane terminal gate variant. */
  terminalGate: boolean;
  /** Recovery-lane escalation / status-only-suppression variant. */
  recoveryDebt: boolean;
  /** Live pulse dot (Working now, actual run). */
  live: boolean;
  /** Provenance: which field resolved this lane (audit trail / QA aid). */
  resolvedFrom: string;
  recovery: IssueRecoveryAction | null;
  scheduledRetry: IssueScheduledRetry | null;
  terminalGates: IssueBlockerDiagnosticNode[];
}

export interface NextActionInput {
  status: IssueStatus;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  scheduledRetry?: IssueScheduledRetry | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  blockerDiagnostics?: IssueBlockerDiagnosticsResponse | null;
  /** True when an actual run is executing against this task right now. */
  hasLiveRun?: boolean;
}

/** A run is live for a touched task only when its own scope names that task. */
export function isRunActiveForIssue(
  run: { status: string; contextSnapshot: Record<string, unknown> | null },
  issueId: string,
): boolean {
  if (run.status !== "queued" && run.status !== "running") return false;
  const scopedId = run.contextSnapshot?.["issueId"] ?? run.contextSnapshot?.["taskId"];
  return typeof scopedId === "string" && scopedId.trim() === issueId;
}

function toRef(
  ref:
    | IssueRelationIssueSummary
    | { id: string; identifier: string | null; title: string; status: IssueStatus }
    | null
    | undefined,
): NextActionIssueRef | null {
  if (!ref) return null;
  return { id: ref.id, identifier: ref.identifier ?? null, title: ref.title, status: ref.status };
}

function truncate(text: string, max = 72): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

const ACTIVE_RETRY_STATUSES = new Set<IssueScheduledRetry["status"]>([
  "scheduled_retry",
  "queued",
  "running",
]);

function workspaceFinalizeBlockers(
  diagnostics: IssueBlockerDiagnosticsResponse | null | undefined,
): IssueBlockerDiagnosticNode[] {
  if (!diagnostics) return [];
  return diagnostics.blockers.filter((blocker) =>
    blocker.flags.includes("workspace_finalize_pending"),
  );
}

function staleBlockerRelations(
  diagnostics: IssueBlockerDiagnosticsResponse | null | undefined,
): IssueBlockerDiagnosticNode[] {
  if (!diagnostics) return [];
  return diagnostics.blockers.filter((blocker) =>
    !blocker.flags.includes("workspace_finalize_pending")
    && (blocker.flags.includes("done_but_blocking")
      || blocker.flags.includes("cancelled_blocker_in_set")),
  );
}

function gateLabel(node: IssueBlockerDiagnosticNode): string | null {
  if (node.flags.includes("workspace_finalize_pending")) return "gate: workspace_finalize_pending";
  if (node.flags.includes("cancelled_blocker_in_set")) return "relation: cancelled_blocker";
  if (node.flags.includes("done_but_blocking")) return "relation: done_but_blocking";
  return null;
}

function ownerFromInbox(owner: IssueBlockedInboxAttention["owner"]): NextActionOwner | null {
  if (!owner) return null;
  const label = owner.label
    ?? (owner.type === "board" ? "Board" : owner.type === "external" ? "External owner" : null);
  if (!label) return null;
  return { label, kind: owner.type };
}

const NONE: NextActionSummary = {
  lane: "none",
  accent: "none",
  laneLabel: "On track",
  statement: "This task has a live next step.",
  why: null,
  owner: null,
  primaryControl: null,
  references: [],
  terminalGate: false,
  recoveryDebt: false,
  live: false,
  resolvedFrom: "no_attention_signal",
  recovery: null,
  scheduledRetry: null,
  terminalGates: [],
};

/**
 * Collapse all next-action signals into a single lane. Only one lane renders.
 */
export function deriveNextAction(input: NextActionInput): NextActionSummary {
  const {
    status,
    blockedInboxAttention: attn,
    activeRecoveryAction,
    scheduledRetry,
    successfulRunHandoff,
    blockerDiagnostics,
    hasLiveRun,
  } = input;

  // Spec §4: the panel hides on terminal tasks so it never adds noise.
  if (status === "done" || status === "cancelled") return NONE;

  const gates = workspaceFinalizeBlockers(blockerDiagnostics);
  const staleRelations = staleBlockerRelations(blockerDiagnostics);
  const retryActive = Boolean(scheduledRetry && ACTIVE_RETRY_STATUSES.has(scheduledRetry.status));

  // 1. Working now — an actual run, or a queued/scheduled corrective wake.
  if (hasLiveRun) {
    return {
      ...NONE,
      lane: "working_now",
      accent: "in_progress",
      laneLabel: "Working now",
      statement: "A run is working on this now.",
      why: "A live run owns the next step.",
      live: true,
      resolvedFrom: "live_run",
      scheduledRetry: scheduledRetry ?? null,
    };
  }
  if (retryActive && scheduledRetry) {
    const running = scheduledRetry.status === "running";
    const agent = scheduledRetry.agentName ?? "the assignee";
    return {
      ...NONE,
      lane: "working_now",
      accent: "in_progress",
      laneLabel: "Working now",
      statement: running ? "A corrective run is in progress." : `Queued to wake ${agent}.`,
      why: scheduledRetry.scheduledRetryReason
        ? truncate(`Corrective wake — ${scheduledRetry.scheduledRetryReason}`, 96)
        : "A corrective wake is scheduled on the next heartbeat.",
      owner: { label: agent, kind: "agent" },
      live: running,
      resolvedFrom: `scheduled_retry:${scheduledRetry.status}`,
      scheduledRetry,
    };
  }

  // 2. Recovery in flight — a routed recovery action owns the fix.
  const recoveryState = activeRecoveryAction
    ? deriveActiveRecoveryDisplayState(activeRecoveryAction)
    : null;
  if (activeRecoveryAction && recoveryState) {
    const escalated = recoveryState === "escalated";
    const accent: NextActionAccent = escalated
      ? "recovery_red"
      : recoveryState === "in_progress"
        ? "recovery_sky"
        : "recovery_amber";
    const attempt = activeRecoveryAction.maxAttempts
      ? `attempt ${activeRecoveryAction.attemptCount}/${activeRecoveryAction.maxAttempts}`
      : `attempt ${activeRecoveryAction.attemptCount}`;
    const ownerLabel = activeRecoveryAction.ownerType === "board"
      ? "Board"
      : activeRecoveryAction.ownerType === "user"
        ? "a user"
        : activeRecoveryAction.ownerType === "agent"
          ? "the assigned agent"
          : "the system";
    return {
      ...NONE,
      lane: "recovery",
      accent,
      laneLabel: escalated ? "Recovery debt" : "Recovery in flight",
      statement: truncate(
        activeRecoveryAction.nextAction || "A recovery action owns the next step.",
      ),
      why: escalated ? `Escalated · ${attempt}.` : `${attempt}.`,
      owner: { label: ownerLabel, kind: activeRecoveryAction.ownerType === "agent" ? "agent" : activeRecoveryAction.ownerType === "board" ? "board" : activeRecoveryAction.ownerType === "user" ? "user" : "system" },
      primaryControl: activeRecoveryAction.recoveryIssueId
        ? {
          label: escalated ? "Assign a worker lane" : "Open recovery",
          kind: escalated ? "assign_worker" : "open_recovery",
          ref: {
            id: activeRecoveryAction.recoveryIssueId,
            identifier: null,
            title: "Recovery task",
            status: "in_progress",
          },
        }
        : null,
      recoveryDebt: escalated,
      resolvedFrom: `active_recovery_action:${recoveryState}`,
      recovery: activeRecoveryAction,
      scheduledRetry: scheduledRetry ?? null,
      terminalGates: gates,
    };
  }

  // 3. Waiting on a decision — approval / interaction / human owner / disposition.
  if (successfulRunHandoff?.required) {
    return {
      ...NONE,
      lane: "waiting_decision",
      accent: "in_review",
      laneLabel: "Waiting on a decision",
      statement: "A run finished — pick a disposition to move on.",
      why: "Mark done, send for review, delegate, or block with an owner.",
      owner: successfulRunHandoff.assigneeAgentId ? { label: "the assignee", kind: "agent" } : null,
      primaryControl: { label: "Choose a disposition", kind: "choose_disposition", ref: null },
      resolvedFrom: "successful_run_handoff",
      scheduledRetry: scheduledRetry ?? null,
    };
  }
  if (attn) {
    const isWaiting =
      Boolean(attn.interactionId || attn.approvalId)
      || attn.state === "awaiting_decision"
      || attn.state === "external_wait"
      || attn.state === "missing_disposition"
      || attn.owner?.type === "board"
      || attn.owner?.type === "user"
      || attn.owner?.type === "external";
    const owner = ownerFromInbox(attn.owner);
    if (isWaiting) {
      const who = owner?.label ?? "an owner";
      return {
        ...NONE,
        lane: "waiting_decision",
        accent: "in_review",
        laneLabel: "Waiting on a decision",
        statement: attn.state === "external_wait"
          ? truncate(`Waiting on ${who} outside Paperclip.`)
          : truncate(`Waiting for ${who} to ${attn.action?.label ?? "respond"}.`, 88),
        why: attn.action?.detail ?? null,
        owner,
        primaryControl: null,
        references: buildReferences(attn, []),
        resolvedFrom: `blocked_inbox:${attn.state}`,
        scheduledRetry: scheduledRetry ?? null,
      };
    }

    const staleLeaf = gates.length === 0
      && (attn.leafIssue?.status === "done" || attn.leafIssue?.status === "cancelled");
    if (staleRelations.length > 0 || staleLeaf) {
      const leafRef = toRef(attn.leafIssue) ?? toRef(staleRelations[0]);
      const leaf = leafRef?.identifier ?? leafRef?.title ?? "the blocker";
      return {
        ...NONE,
        lane: "recovery",
        accent: "recovery_red",
        laneLabel: "Recovery debt",
        statement: truncate(`Clear or replace the stale blocker relation for ${leaf}.`, 88),
        why: "A Done or cancelled task cannot keep acting as unfinished work.",
        owner: { label: "Board", kind: "board" },
        primaryControl: leafRef
          ? { label: "Open stale blocker", kind: "open_blocker", ref: leafRef }
          : null,
        references: buildReferences(attn, [...gates, ...staleRelations]),
        recoveryDebt: true,
        resolvedFrom: "stale_blocker_relation",
        scheduledRetry: scheduledRetry ?? null,
        terminalGates: gates,
      };
    }

    // 4. Blocked by real work (with workspace-finalize gate variant).
    const terminalGate = gates.length > 0;
    const leaf = attn.leafIssue?.identifier ?? attn.leafIssue?.title ?? "an upstream task";
    return {
      ...NONE,
      lane: "blocked_real_work",
      accent: "todo",
      laneLabel: "Blocked by real work",
      statement: terminalGate
        ? truncate(`Blocked by ${leaf} — it's Done but its gate hasn't cleared.`, 88)
        : truncate(`Blocked by ${leaf} until it finishes.`),
      why: attn.action ? truncate(`${attn.action.label}${attn.action.detail ? ` — ${attn.action.detail}` : ""}`, 120) : null,
      owner,
      primaryControl: terminalGate && attn.recoveryIssue
        ? { label: "Open recovery", kind: "open_recovery", ref: toRef(attn.recoveryIssue) }
        : null,
      references: buildReferences(attn, gates),
      terminalGate,
      resolvedFrom: terminalGate ? "terminal_gate" : `blocked_inbox:${attn.state}`,
      scheduledRetry: scheduledRetry ?? null,
      terminalGates: gates,
    };
  }

  // 5. Stale relations need repair, not terminal-gate recovery.
  if (staleRelations.length > 0) {
    const first = staleRelations[0];
    return {
      ...NONE,
      lane: "recovery",
      accent: "recovery_red",
      laneLabel: "Recovery debt",
      statement: truncate(
        `Clear or replace the stale blocker relation for ${first.identifier ?? first.title}.`,
        88,
      ),
      why: "A Done or cancelled blocker still remains in the relation set.",
      primaryControl: {
        label: "Open stale blocker",
        kind: "open_blocker",
        ref: toRef(first)!,
      },
      references: [{ label: "Stale blocker", ref: toRef(first)!, gate: gateLabel(first) }],
      recoveryDebt: true,
      resolvedFrom: "stale_blocker_relation",
      scheduledRetry: scheduledRetry ?? null,
    };
  }

  // 6. Blocker diagnostics alone can still reveal a workspace-finalize gate.
  if (gates.length > 0) {
    const first = gates[0];
    return {
      ...NONE,
      lane: "blocked_real_work",
      accent: "todo",
      laneLabel: "Blocked by real work",
      statement: truncate(
        `Blocked by ${first.identifier ?? first.title} — Done, but its gate hasn't cleared.`,
        88,
      ),
      why: "A post-run gate on a Done blocker still holds this task.",
      primaryControl: null,
      references: [
        {
          label: "Blocked by",
          ref: toRef(first)!,
          gate: gateLabel(first),
        },
      ],
      terminalGate: true,
      resolvedFrom: "terminal_gate",
      scheduledRetry: scheduledRetry ?? null,
      terminalGates: gates,
    };
  }

  return NONE;
}

function buildReferences(
  attn: IssueBlockedInboxAttention,
  gates: IssueBlockerDiagnosticNode[],
): NextActionReference[] {
  const refs: NextActionReference[] = [];
  const gateByIdentifier = new Map<string, IssueBlockerDiagnosticNode>();
  for (const gate of gates) {
    const key = gate.identifier ?? gate.id;
    gateByIdentifier.set(key, gate);
  }
  if (attn.sourceIssue) {
    refs.push({ label: "Work happens on", ref: toRef(attn.sourceIssue)! });
  }
  if (attn.leafIssue) {
    const key = attn.leafIssue.identifier ?? attn.leafIssue.id;
    refs.push({
      label: "Waiting on",
      ref: toRef(attn.leafIssue)!,
      gate: gateByIdentifier.has(key) ? gateLabel(gateByIdentifier.get(key)!) : null,
    });
  }
  // Any terminal gate not already attached to the leaf gets its own chip.
  for (const gate of gates) {
    const key = gate.identifier ?? gate.id;
    const leafKey = attn.leafIssue?.identifier ?? attn.leafIssue?.id;
    if (key === leafKey) continue;
    refs.push({ label: "Blocked by", ref: toRef(gate)!, gate: gateLabel(gate) });
  }
  if (attn.recoveryIssue) {
    refs.push({ label: "Recovery", ref: toRef(attn.recoveryIssue)! });
  }
  return refs;
}

/**
 * Compact, per-node verdict for the subtree / blocker diagnostics view
 * One line per node lets the operator scan a whole
 * tree and find where work moves next without opening every child.
 *
 * A subtree node only carries what the diagnostics endpoint exposes — status
 * plus its own blocker set with terminal-gate flags — so this is a deliberate
 * subset of the four-lane resolver: Working now / Blocked by real work (with
 * the terminal-gate + recovery-debt variants surfaced from blocker flags).
 * The single actionable leaf is chosen across nodes by {@link selectActionableLeafNodeId}.
 */
export interface NextActionNodeBadge {
  lane: NextActionLane;
  accent: NextActionAccent;
  /** Short lane label, e.g. "Blocked", "Recovery", "Recovery debt", "Working". */
  laneLabel: string;
  /** Compact verdict, e.g. "Blocked → PAP-123", "Recovery → workspace gate". */
  statement: string;
  /** The upstream node the operator should look at next, when there is one. */
  target: NextActionIssueRef | null;
  /** Terminal-gate evidence chip, when the node is held by a gate. */
  gate: string | null;
  /** True when this node itself can move (unblocked, non-terminal). */
  ready: boolean;
  resolvedFrom: string;
}

function unresolvedBlockers(node: IssueSubtreeDiagnosticNode): IssueBlockerDiagnosticNode[] {
  return node.blockers.filter((b) => b.isUnresolved);
}

function nodeGate(node: IssueSubtreeDiagnosticNode): IssueBlockerDiagnosticNode | null {
  return (
    node.blockers.find((b) => b.flags.includes("cancelled_blocker_in_set"))
    ?? node.blockers.find((b) => b.flags.includes("workspace_finalize_pending"))
    ?? node.blockers.find((b) => b.flags.includes("done_but_blocking"))
    ?? null
  );
}

function blockerRef(node: IssueBlockerDiagnosticNode): NextActionIssueRef {
  return { id: node.id, identifier: node.identifier, title: node.title, status: node.status };
}

function blockerLabel(node: IssueBlockerDiagnosticNode): string {
  return node.identifier ?? node.title ?? node.id.slice(0, 8);
}

export function deriveSubtreeNodeBadge(node: IssueSubtreeDiagnosticNode): NextActionNodeBadge {
  const status = node.issue.status;

  // Terminal nodes never carry a next action — render them muted, never actionable.
  if (status === "done" || status === "cancelled") {
    return {
      lane: "none",
      accent: "none",
      laneLabel: status === "done" ? "Done" : "Cancelled",
      statement: status === "done" ? "Complete." : "Cancelled.",
      target: null,
      gate: null,
      ready: false,
      resolvedFrom: `status:${status}`,
    };
  }

  const gate = nodeGate(node);
  if (gate) {
    // A cancelled blocker left in the set is unhealthy — it needs a worker lane,
    // not a wait. Everything else is a routed/system gate we can name and hold on.
    if (gate.flags.includes("cancelled_blocker_in_set")) {
      return {
        lane: "recovery",
        accent: "recovery_red",
        laneLabel: "Recovery debt",
        statement: "Recovery debt → assign worker",
        target: blockerRef(gate),
        gate: gateLabel(gate),
        ready: false,
        resolvedFrom: "cancelled_blocker_in_set",
      };
    }
    if (gate.flags.includes("workspace_finalize_pending")) {
      return {
        lane: "recovery",
        accent: "recovery_sky",
        laneLabel: "Recovery",
        statement: "Recovery → workspace gate",
        target: blockerRef(gate),
        gate: gateLabel(gate),
        ready: false,
        resolvedFrom: "workspace_finalize_pending",
      };
    }
    // A Done blocker left in the relation set is recovery debt, not a gate.
    return {
      lane: "recovery",
      accent: "recovery_red",
      laneLabel: "Recovery debt",
      statement: "Recovery debt → clear stale blocker",
      target: blockerRef(gate),
      gate: gateLabel(gate),
      ready: false,
      resolvedFrom: "done_but_blocking",
    };
  }

  const unresolved = unresolvedBlockers(node);
  if (unresolved.length > 0) {
    const first = unresolved[0];
    const extra = unresolved.length > 1 ? ` +${unresolved.length - 1}` : "";
    return {
      lane: "blocked_real_work",
      accent: "todo",
      laneLabel: "Blocked",
      statement: `Blocked → ${blockerLabel(first)}${extra}`,
      target: blockerRef(first),
      gate: null,
      ready: false,
      resolvedFrom: "unresolved_blockers",
    };
  }

  // Status is not proof of liveness. Only a queued/claimed wake demonstrates
  // that active-looking work currently has a continuation in this diagnostic.
  const inProgress = status === "in_progress" || status === "in_review";
  const hasLiveWake = node.wakeEvents.some(
    (event) => event.kind === "wake_request" && (event.status === "queued" || event.status === "claimed"),
  );
  if (inProgress && !hasLiveWake) {
    return {
      lane: "recovery",
      accent: "recovery_amber",
      laneLabel: "Needs recovery",
      statement: "No live continuation.",
      target: null,
      gate: null,
      ready: false,
      resolvedFrom: "active_without_live_continuation",
    };
  }
  return {
    lane: inProgress ? "working_now" : "none",
    accent: inProgress ? "in_progress" : "none",
    laneLabel: inProgress ? "Working" : "Ready",
    statement: inProgress ? "Work is moving here." : "Ready to run.",
    target: null,
    gate: null,
    ready: true,
    resolvedFrom: inProgress ? "live_wake" : "unblocked_ready",
  };
}

/**
 * Across a subtree, pick the ONE node the operator should act on — the single
 * actionable leaf the spec highlights. Priority: an unblocked leaf where work
 * can move now → an unhealthy recovery-debt node needing a worker → the nearest
 * routed recovery/terminal gate. Returns null when nothing is actionable
 * (e.g. every node is done or waiting purely on healthy upstream work).
 */
export function selectActionableLeafNodeId(
  nodes: IssueSubtreeDiagnosticNode[],
): string | null {
  const scored = nodes.map((node) => ({ node, badge: deriveSubtreeNodeBadge(node) }));
  const parentNodeIds = new Set(nodes.flatMap((node) => node.parentId ? [node.parentId] : []));
  const isLeaf = (node: IssueSubtreeDiagnosticNode) => !parentNodeIds.has(node.issue.id);
  const ready = scored.find(({ node, badge }) => badge.ready && isLeaf(node));
  if (ready) return ready.node.issue.id;
  const debt = scored.find(
    ({ node, badge }) =>
      isLeaf(node)
      && (badge.resolvedFrom === "cancelled_blocker_in_set"
        || badge.resolvedFrom === "done_but_blocking"),
  );
  if (debt) return debt.node.issue.id;
  const recovery = scored.find(({ node, badge }) => badge.lane === "recovery" && isLeaf(node));
  if (recovery) return recovery.node.issue.id;
  return null;
}
