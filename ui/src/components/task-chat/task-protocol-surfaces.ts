/**
 * Exhaustive product disposition for Paperclip Runner Protocol surfaces.
 *
 * This is intentionally separate from the renderer: adding a protocol event
 * must be a conscious product decision even when the decision is to fold it
 * into an existing turn or keep it in DevTools. The contract test compares
 * these keys with the canonical JSON schemas.
 */
export type TaskProtocolDisposition = "inline" | "folded" | "debug-only";

export interface TaskProtocolSurfaceRegistration {
  disposition: TaskProtocolDisposition;
  surface: string;
  story: string | null;
  rationale: string;
}

const inline = (surface: string, story: string, rationale: string): TaskProtocolSurfaceRegistration => ({
  disposition: "inline",
  surface,
  story,
  rationale,
});

const folded = (surface: string, rationale: string): TaskProtocolSurfaceRegistration => ({
  disposition: "folded",
  surface,
  story: null,
  rationale,
});

const debugOnly = (surface: string, rationale: string): TaskProtocolSurfaceRegistration => ({
  disposition: "debug-only",
  surface,
  story: null,
  rationale,
});

const providerEvents = [
  "plan.updated",
  "tool.execution.started", "tool.execution.progressed", "tool.execution.completed",
  "research.started", "research.progressed", "research.completed",
  "delegation.started", "delegation.updated", "delegation.completed",
  "model.route.changed", "model.verification.updated", "context.compacted",
  "artifact.viewed", "artifact.generated", "review.mode.changed",
  "hook.started", "hook.completed", "memory.citation.referenced",
  "safety.review.started", "safety.review.completed", "terminal.input.sent",
  "wait.started", "wait.completed", "provider.notice.recorded",
] as const;

const runnerLifecycleEvents = [
  "runner.connected", "runner.reconnected", "runner.reconciled", "runner.disconnected",
  "runner.draining", "runner.backpressure", "runner.suspending", "runner.suspended", "runner.stopped",
  "runtime.phase.changed", "workspace.ready",
  "harness.starting", "harness.ready", "harness.exited",
  "session.starting", "session.started", "session.resuming", "session.resumed",
  "session.reconciled", "session.updated", "session.closed",
  "turn.submitted", "turn.accepted", "turn.started", "turn.completed",
  "run.attached", "run.detached",
] as const;

const diagnosticEvents = [
  "runner.diagnostic", "harness.diagnostic", "session.failed", "turn.failed",
  "turn.interrupted", "turn.cancelled", "item.failed",
] as const;

const itemEvents = ["item.started", "item.delta", "item.completed", "usage.reported"] as const;

const mcpLifecycleEvents = [
  "mcp_app.discovered", "mcp_app.resource.resolved", "mcp_app.initializing", "mcp_app.ready",
  "mcp_app.host_context.changed", "mcp_app.failed", "mcp_app.teardown",
] as const;

const interactionLifecycleEvents = [
  "interaction.request.proposed", "interaction.request.materialized", "interaction.request.rejected",
  "interaction.response.progressed", "interaction.response.resolved", "interaction.response.delivered",
] as const;

const governanceEvents = [
  "attention.request.proposed", "attention.request.routed", "attention.request.resolved",
  "attention.request.expired", "attention.request.superseded", "work.assessment.recorded",
  "issue.status.decision.recorded", "issue.status.decision.applied", "issue.status.decision.rejected",
  "issue.status.decision.superseded",
] as const;

export const TASK_PROTOCOL_EVENT_SURFACE_REGISTRY: Readonly<Record<string, TaskProtocolSurfaceRegistration>> = Object.freeze({
  ...Object.fromEntries(providerEvents.map((eventType) => [eventType, inline("provider_activity", "Task Page/Runner Protocol/Provider semantics", "Provider-neutral semantic activity is readable in the task turn.")])),
  "workspace.change.updated": inline("workspace_change", "Task Page/Runner Protocol/Workspace changes", "In-progress workspace changes update one diff card."),
  "workspace.diff.recorded": inline("workspace_change", "Task Page/Runner Protocol/Workspace changes", "The runner-verified final diff replaces the in-progress revision."),
  "workspace.file.referenced": inline("workspace_file", "Task Page/Runner Protocol/File references", "Verified references open a bounded preview and the production file viewer."),
  "semantic_tool.input": folded("tool", "Semantic operations reuse the production tool row."),
  "semantic_tool.result": folded("tool", "Semantic operation outcomes update the matching tool row."),
  "semantic_tool.reconciled": folded("tool", "Recovered semantic operation outcomes update the matching tool row without duplicating it."),
  "mcp_app.tool_input": folded("tool", "MCP inputs reuse the production tool row."),
  "mcp_app.tool_result": folded("tool", "MCP outcomes update the matching tool row."),
  "mcp_app.action.requested": folded("interaction", "Action requests materialize as authoritative issue-thread interactions."),
  "mcp_app.action.resolved": folded("interaction", "Action resolution is shown on the authoritative interaction card."),
  "runtime_request.created": inline("runtime_request", "Task Page/Runner Protocol/Runtime requests", "Pending provider runtime requests remain visible and actionable when a resolver is available."),
  "runtime_request.resolved": folded("runtime_request", "Resolution updates the existing request card."),
  "runtime_request.expired": folded("runtime_request", "Expiry updates the existing request card."),
  "runtime_request.cancelled": folded("runtime_request", "Cancellation updates the existing request card."),
  ...Object.fromEntries(interactionLifecycleEvents.map((eventType) => [eventType, folded("interaction", "The control-plane interaction record is canonical and owns rendering." )])),
  "run.result.proposed": inline("run_result", "Task Page/Runner Protocol/Results and terminal states", "Structured completion, evidence, verification, blockers, and artifacts remain inspectable."),
  "run.result.accepted": folded("run_result", "Acceptance updates the existing result without duplicating it."),
  "run.result.rejected": folded("run_result", "Rejected results remain part of run governance rather than a second completion card."),
  "run.terminal": inline("run_terminal", "Task Page/Runner Protocol/Results and terminal states", "Terminal outcome and stop reason remain visible."),
  ...Object.fromEntries(runnerLifecycleEvents.map((eventType) => [eventType, folded("turn", "Routine lifecycle transitions are summarized by the run turn and composer state.")])),
  ...Object.fromEntries(diagnosticEvents.map((eventType) => [eventType, folded("system_notice", "Actionable failure text is folded into the run or system notice.")])),
  ...Object.fromEntries(itemEvents.map((eventType) => [eventType, folded("conversation_or_tool", "Item payloads normalize into messages, reasoning, tools, diffs, or usage." )])),
  "sandbox.metric": debugOnly("run_debug", "Sandbox telemetry is available in run details, not the primary task thread."),
  ...Object.fromEntries(mcpLifecycleEvents.map((eventType) => [eventType, debugOnly("run_debug", "MCP application transport lifecycle remains in run details unless it produces an actionable failure.")])),
  ...Object.fromEntries(governanceEvents.map((eventType) => [eventType, folded("governance", "Authoritative task status, attention, and interaction records own this state." )])),
});

export const TASK_PROTOCOL_REQUEST_SURFACE_REGISTRY = Object.freeze({
  "runtime.permission": inline("runtime_request", "Task Page/Runner Protocol/Runtime requests", "Permission choices render on the runtime request card."),
  "runtime.input": inline("runtime_request", "Task Page/Runner Protocol/Runtime requests", "Structured runtime input renders on the runtime request card."),
  "issue_thread.request_confirmation": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production confirmation card."),
  "issue_thread.request_checkbox_confirmation": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production bounded checkbox card."),
  "issue_thread.request_item_verdicts": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production per-item verdict card."),
  "issue_thread.ask_user_questions": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production typed question controls."),
  "issue_thread.suggest_tasks": inline("interaction", "Task Page/Runner Protocol/Interactions", "Uses the production task suggestion tree."),
});

export const TASK_PROTOCOL_RESULT_DISPOSITION_REGISTRY = Object.freeze({
  done: "run_result",
  blocked: "run_result",
  needs_review: "run_result",
  yielded: "run_result",
} as const);

export const TASK_PROTOCOL_TURN_TERMINAL_REGISTRY = Object.freeze({
  completed: "run_terminal",
  failed: "run_terminal",
  interrupted: "run_terminal",
  cancelled: "run_terminal",
} as const);

export const TASK_PROTOCOL_RUN_TERMINAL_REGISTRY = Object.freeze({
  succeeded: "run_terminal",
  failed: "run_terminal",
  cancelled: "run_terminal",
} as const);
