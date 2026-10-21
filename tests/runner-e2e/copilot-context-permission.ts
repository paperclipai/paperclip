import { COPILOT_CONTEXT_DISCOVERY_LIMIT, isCopilotContextDiscoveryProgress } from "./copilot-context-evidence.js";
import { copilotPendingPermissionCard } from "./copilot-permission-card.js";
import { expect, type Page } from "@playwright/test";
import { pollUntil } from "./api.js";
import { readCopilotToolEvidence } from "./copilot-evidence.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";

type Row = Record<string, any>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

/** Fixture human decision, never an automatic production permission rule. */
export function pendingCopilotContextPermission(events: readonly unknown[], companyId: string, runId: string) {
  const rows = events.map(record), notices = readCopilotToolEvidence(events, runId);
  const closed = new Set(rows.filter(r => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(r.eventType))
    .map(r => record(record(record(r.payload).prpEvent).payload).requestId));
  const pending = rows.filter(r => r.eventType === "runtime_request.created" && !closed.has(record(record(record(r.payload).prpEvent).payload).request?.requestId));
  if (!pending.length) return undefined;
  if (pending.length !== 1) throw new Error("Context fixture requires one exact pending request");
  const row = pending[0]!, frame = record(record(row.payload).prpEvent), request = record(record(frame.payload).request);
  const operationId = request.prompt;
  if (operationId !== "get_task_context" && operationId !== "search_api") throw new Error("Context fixture cannot approve another operation");
  const discovery = operationId === "search_api";
  const permissions = notices.filter(n => n.stage === "permission_requested" && n.requestId === request.requestId);
  if (!permissions.length) return undefined; // Native notice can follow the durable card.
  if (permissions.length !== 1 || !permissions[0]!.declineOffered) throw new Error("Context fixture permission is ambiguous");
  const native = permissions[0]!, group = notices.filter(n => n.toolCallId === native.toolCallId);
  const tools = group.filter(n => n.stage === "tool");
  const started = group.filter(n => n.stage === "tool" && n.status === "pending" && n.operation === (discovery ? undefined : "read"));
  const canonical = rows.filter(r => r.eventType === "tool.execution.started" && record(record(record(r.payload).prpEvent).payload).executionId === native.toolCallId);
  if (tools.length > 1 || started.length !== tools.length || canonical.length > 1 || group.length !== permissions.length + tools.length
    || group.some(n => n.target !== undefined || n.commandSha256 !== undefined || n.shellId !== undefined || n.readTargetSha256 !== undefined)) throw new Error("Context fixture lacks an exact read-only origin");
  for (const r of [row, ...canonical, ...group.map(n => rows.find(r => r.seq === n.seq)!)]) {
    const e = record(record(r?.payload).prpEvent);
    if (r?.companyId !== companyId || r.runId !== runId || e.schema !== "paperclip.prp.event.v1" || e.sourceKind !== "runner"
      || e.eventType !== r.eventType || e.runId !== runId || e.turnId !== native.turnId || e.normalizedSessionId !== frame.normalizedSessionId
      || e.sourceInstanceId !== frame.sourceInstanceId || r.sourceInstanceId !== e.sourceInstanceId || r.sourceSeq !== e.sourceSeq
      || !Number.isSafeInteger(e.sourceSeq) || !Number.isSafeInteger(r.seq)) throw new Error("Context fixture has foreign durable evidence");
  }
  if (request.schema !== "paperclip.runtime_request.v2" || request.type !== "permission" || request.status !== "pending"
    || request.requestKind !== "permission_approval" || request.turnId !== native.turnId || request.method !== "session/request_permission"
    || !(hasAcpxNativeOrigin(request.origin, "copilot", "session/request_permission") || hasAcpxNativeOrigin(request.origin, "acpx", "session/request_permission"))
    || !Array.isArray(request.choices) || !["accept", "decline"].every(key => request.choices.some((c: Row) => c.key === key))) throw new Error("Context fixture cannot approve this card");
  const tool = record(record(record(canonical[0]?.payload).prpEvent).payload);
  if (canonical.length && (tool.name !== `paperclip-${operationId}` || tool.operation !== (discovery ? "search" : "read") || tool.readOnly !== true || tool.target !== null || tool.transport !== "builtin")) throw new Error("Context fixture cannot approve this card");
  if (!started.length || !canonical.length) return undefined; // Await matching origin rows within the existing deadline.
  if (discovery && !isCopilotContextDiscoveryProgress(tool.progress)) throw new Error("Context discovery must search only for the required context tool");
  return { operationId, runId, requestId: native.requestId!, turnId: native.turnId, toolCallId: native.toolCallId };
}

export async function approveCopilotContextThroughUi(input: {
  page: Page; companyId: string; deadlineAt: number;
  load(): Promise<{ run: Row; events: readonly unknown[] }>;
  evidence(name: string, data: unknown): Promise<void>;
}) {
  const label = "initial Copilot context permission", decided = new Set<string>();
  for (let index = 0; index <= COPILOT_CONTEXT_DISCOVERY_LIMIT; index++) {
    const result = await pollUntil({ label, deadlineAt: input.deadlineAt, intervalMs: 200,
      load: async () => {
        const state = await input.load();
        if (["failed", "timed_out", "cancelled", "succeeded"].includes(state.run.status)) throw new Error(`Stopped waiting for ${label}: run ended`);
        if (!state.run.id) return undefined;
        const notices = readCopilotToolEvidence(state.events, state.run.id);
        if (notices.some(n => n.semanticOperationId === "get_task_context" && n.status === "completed" && n.semanticOutcome === "returned")) return { completed: true as const };
        try {
          const pending = pendingCopilotContextPermission(state.events, input.companyId, state.run.id);
          if (pending && decided.has(pending.requestId)) return undefined; // Await durable closure after the browser POST.
          return pending ? { pending } : undefined;
        } catch (error) { throw new Error(`Stopped waiting for ${label}: ${error instanceof Error ? error.message : "invalid request"}`); }
      }, accept: Boolean });
    if (!result || "completed" in result) return;
    const { pending } = result;
    if (decided.has(pending.requestId)) throw new Error("Context fixture cannot replay a bootstrap decision");
    decided.add(pending.requestId);
    const card = copilotPendingPermissionCard(input.page, pending.operationId);
    await expect(card).toHaveCount(1); await expect(card).toContainText(pending.operationId);
    const path = `/api/heartbeat-runs/${pending.runId}/runtime-requests/${encodeURIComponent(pending.requestId)}/resolve`;
    const sent = input.page.waitForRequest(r => new URL(r.url()).pathname === path && r.method() === "POST");
    await card.getByRole("button", { name: "Allow once", exact: true }).click();
    const body = (await sent).postDataJSON();
    if (body.turnId !== pending.turnId || body.requestKind !== "permission_approval" || body.resolution?.action !== "accept") throw new Error("Context fixture submitted a foreign decision");
    await input.evidence(`copilot-initial-${index}-${pending.operationId}-decision.json`, { schema: "paperclip.e2e.copilot-context-decision.v1", ...pending, action: "accept", source: "normal browser permission card; fixture human decision" });
    if (pending.operationId === "get_task_context") return;
  }
  throw new Error("Context fixture exhausted its bounded bootstrap decisions");
}

/** Publish the observed remote action while the provider can still be waiting
 * on its context card. Waiting for that card first leaves the setup file absent
 * throughout the provider's bounded read window. Never approve another tool. */
export async function prepareCopilotContext(input: {
  remoteSetup?: () => Promise<void>;
  approveContext(): Promise<void>;
}): Promise<void> {
  await input.remoteSetup?.();
  await input.approveContext();
}
