import type {
  CompanySkillTestRun,
  CompanySkillTestRunDetail,
  CompanySkillTestRunStatus,
} from "@paperclipai/shared";

/**
 * Pure logic for the Skill Studio UI (PAP-12962). Kept free of React so the
 * three behavioural contracts the acceptance criteria call out — run-status
 * derivation, the disabled-Run matrix, and interaction inline-vs-fallback
 * routing — are unit-testable in isolation.
 */

export const TERMINAL_RUN_STATUSES: readonly CompanySkillTestRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminalRunStatus(status: CompanySkillTestRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** V1 poll policy: poll every 2s while a run is non-terminal, stop on terminal. */
export function shouldPollRun(status: CompanySkillTestRunStatus): boolean {
  return !isTerminalRunStatus(status);
}

/**
 * Map a test-run status onto the shared `StatusBadge` status vocabulary so the
 * Studio never invents a bespoke chip (spec D6). `queued` aligns with the
 * pending/yellow treatment.
 */
export type RunBadgeStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export function runBadgeStatus(status: CompanySkillTestRunStatus): RunBadgeStatus {
  return status;
}

/**
 * What the right-pane output region should render for a run.
 * - `output`      — a completed run with output body.
 * - `draft`       — a failed/cancelled run that still produced partial output
 *                   ("draft at failure").
 * - `pending`     — non-terminal run, output not ready yet.
 * - `none`        — terminal run with no output at all.
 */
export type RunOutputMode = "output" | "draft" | "pending" | "none";

export function runOutputMode(run: {
  status: CompanySkillTestRunStatus;
  outputBody?: string | null;
}): RunOutputMode {
  const hasOutput = Boolean(run.outputBody && run.outputBody.trim().length > 0);
  if (!isTerminalRunStatus(run.status)) {
    return hasOutput ? "output" : "pending";
  }
  if (run.status === "succeeded") {
    return hasOutput ? "output" : "none";
  }
  // failed / cancelled
  return hasOutput ? "draft" : "none";
}

/** Failed runs get an error card at the top of the detail view; cancelled do not. */
export function showRunErrorCard(status: CompanySkillTestRunStatus): boolean {
  return status === "failed";
}

/**
 * Whether the "Open test task ↗" deep link is live. A retention-expired or
 * hard-deleted harness issue leaves the run row intact (self-contained
 * snapshots) but disables the link with a "Test task expired" tooltip.
 */
export function testTaskLinkState(run: {
  taskExpired: boolean;
  harnessIssue?: { id: string } | null;
}): { enabled: boolean; reason: string | null } {
  if (run.taskExpired || !run.harnessIssue) {
    return { enabled: false, reason: "Test task expired" };
  }
  return { enabled: true, reason: null };
}

// ---------------------------------------------------------------------------
// Disabled-Run matrix (contract §7.1 "Buttons")
// ---------------------------------------------------------------------------

export interface RunGateInput {
  /** An agent is selected in the picker (paused agents are never selectable). */
  hasAgent: boolean;
  /** The active input (saved or ad-hoc paste) has non-whitespace content. */
  hasInput: boolean;
  /** Number of files in the skill under test. */
  skillFileCount: number;
  /** A run is already in flight from this surface (optional guard). */
  runInFlight?: boolean;
}

export interface RunGateResult {
  disabled: boolean;
  /** Tooltip copy naming the reason, or null when the Run button is enabled. */
  reason: string | null;
}

/**
 * Evaluate the Run button's disabled state. Reasons are checked in priority
 * order and the first blocking condition wins, so the tooltip always names a
 * single actionable reason (recognition over recall).
 */
export function evaluateRunGate(input: RunGateInput): RunGateResult {
  if (input.skillFileCount <= 0) {
    return { disabled: true, reason: "This skill has no files to test" };
  }
  if (!input.hasAgent) {
    return { disabled: true, reason: "Pick an agent to run" };
  }
  if (!input.hasInput) {
    return { disabled: true, reason: "Add or paste input text to run" };
  }
  if (input.runInFlight) {
    return { disabled: true, reason: "A run is already in progress" };
  }
  return { disabled: false, reason: null };
}

// ---------------------------------------------------------------------------
// Interaction inline-vs-fallback routing (board 12)
// ---------------------------------------------------------------------------

/**
 * Interaction kinds that render as inline, answerable cards inside the Studio.
 * Answering posts to the real interaction on the hidden harness task; every
 * other kind is shown as a non-dropped summary row that links out to the task.
 */
export const INLINE_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "ask_user_questions",
  "request_confirmation",
]);

export type InteractionRendering = "inline" | "fallback";

export function routeInteraction(kind: string): InteractionRendering {
  return INLINE_INTERACTION_KINDS.has(kind) ? "inline" : "fallback";
}

/** An interaction is answerable inline only while it is still pending. */
export function isInteractionAnswerable(interaction: { kind: string; status: string }): boolean {
  return routeInteraction(interaction.kind) === "inline" && interaction.status === "pending";
}

// ---------------------------------------------------------------------------
// Agent picker helpers
// ---------------------------------------------------------------------------

export interface AgentPickerItem {
  id: string;
  status: string;
}

/** Paused agents are muted and unselectable in the picker. */
export function isAgentSelectable(agent: { status: string }): boolean {
  return agent.status !== "paused";
}

// ---------------------------------------------------------------------------
// Run label helpers
// ---------------------------------------------------------------------------

/**
 * Short, stable run identifier for history rows (`#` + first 7 of the id),
 * mirroring how the run detail header labels a run.
 */
export function runShortId(run: Pick<CompanySkillTestRun, "id">): string {
  return `#${run.id.replace(/-/g, "").slice(0, 7)}`;
}

export function isRunActive(run: Pick<CompanySkillTestRun, "status">): boolean {
  return !isTerminalRunStatus(run.status);
}

/** The output document, if the run detail carries one under its output key. */
export function findOutputDocument(detail: Pick<CompanySkillTestRunDetail, "documents" | "outputDocumentKey">) {
  return detail.documents.find((doc) => doc.key === detail.outputDocumentKey) ?? null;
}
