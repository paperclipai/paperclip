import { createHash } from "node:crypto";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import { redactPaperclipSemanticValue, redactSemanticValue } from "../../semantic-tools/redaction.js";
import { COPILOT_ACP_EVENT_METHOD, normalizeCopilotSessionEvent, type CopilotSessionEvent } from "./copilot-events.js";
import type { AcpxProfileExtensionAdapter, AcpxProfileExtensionContext } from "./profile-extensions.js";

/** Display projection only. Native notices cannot settle or charge a runner turn. */
export function createCopilotProfileExtensionAdapter(context: AcpxProfileExtensionContext): AcpxProfileExtensionAdapter {
  let sequence = 0;
  return {
    async request() {
      throw new Error("Copilot 1.0.88 has no qualified inbound ACP extension request responder");
    },
    async notification(method, params) {
      if (method !== COPILOT_ACP_EVENT_METHOD) return [];
      const event = normalizeCopilotSessionEvent({ method, params }, context);
      if (!event) return [];
      const noticeId = identity(context, "notice", String(++sequence));
      // The optional canonical provenance object requires an originating turn.
      // Session-only evidence keeps its complete source identity in details.
      const details = detailFields({ ...event.data,
        source: { method, eventType: event.sourceType, sessionId: event.sessionId,
          ...(event.agentId ? { agentId: event.agentId } : {}),
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        },
        turnAttribution: "unknown: provider session notification has no originating turn ID",
      });
      const notice: CanonicalProviderEvent = {
        itemId: noticeId,
        eventType: "provider.notice.recorded",
        payload: {
          schema: "paperclip.provider.notice.v1", noticeId,
          severity: event.kind === "capability_gap" ? "warning" : "info",
          category: `copilot.${event.sourceType}`, scope: "session",
          recoverable: true, userActionable: false,
          summary: summary(event),
          details,
        },
      };
      // Receipt during this turn is not proof of origin. Keep all safe fields
      // as session evidence; typed turn activity would misattribute late events.
      return [notice];
    },
  };
}

function summary(event: CopilotSessionEvent): string {
  const data = event.data;
  if (event.kind === "capability_gap") return data.reason === "provider_omitted_event_data"
    ? "Copilot omitted the payload of a native activity event."
    : "Copilot reported native input without a qualified ACP response method.";
  switch (event.sourceType) {
    case "assistant.usage": return "Copilot reported supplemental model usage; these counters do not establish a dollar charge.";
    case "session.usage_checkpoint": return "Copilot reported a cumulative AI-unit checkpoint; it is not a dollar charge.";
    case "session.usage_info": return "Copilot updated context usage.";
    case "session.workspace_file_changed": return `Copilot ${data.operation === "create" ? "created" : "updated"} a provider-session file; artifact resolution is pending.`;
    case "session.binary_asset": return "Copilot reported a verified binary asset; artifact registration is pending.";
    case "subagent.started": return "Copilot started a subagent.";
    case "subagent.configured": return "Copilot updated subagent configuration.";
    case "subagent.completed": return data.cancelled === true ? "Copilot subagent was interrupted." : "Copilot subagent completed.";
    case "subagent.failed": return "Copilot subagent failed.";
    case "session.plan_changed": return "Copilot changed its plan; this notification does not contain the plan document.";
    case "session.compaction_start": return "Copilot started context compaction.";
    case "session.compaction_complete": return data.success === true ? "Copilot completed context compaction." : "Copilot reported context compaction without a successful result.";
    case "pending_messages.modified": return "Copilot changed its pending messages; the notification does not include queue contents.";
    case "session.background_tasks_changed": return "Copilot background tasks changed; the notification does not include task contents.";
    case "session.context_changed": return "Copilot reported context changes; the admitted workspace remains fixed.";
    case "session.permissions_changed": return "Copilot reported permission state; Paperclip policy remains authoritative.";
    case "session.mode_changed": return "Copilot reported a mode change.";
    case "session.idle": return "Copilot reported idle activity; the ACP prompt response determines turn settlement.";
    case "session.completion_receipt": return "Copilot reported a completion receipt; it does not independently settle the turn.";
    default: return "Copilot reported native activity.";
  }
}

function detailFields(data: Record<string, unknown>): Array<{ name: string; value: string }> {
  const details: Array<{ name: string; value: string }> = [];
  const visit = (value: unknown, name: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value)) visit(entry, name ? `${name}.${key}` : key);
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      // Preserve the complete field path for sensitive-key redaction. The
      // normalizer admits only known, typed counters/flags: their numeric token
      // counts are not credentials, so they retain value-only redaction.
      const safe = typeof value === "string" ? redactSemanticValue(value, name) : value;
      details.push({ name: bounded(name, 160), value: bounded(String(safe), 4000) });
    }
  };
  visit(data, "");
  if (details.length > 64) throw new Error("Copilot projected detail fields exceed their declared bound");
  return details;
}
function identity(context: AcpxProfileExtensionContext, family: string, source: string): string {
  return `copilot-${family}-${createHash("sha256").update(JSON.stringify([context.sessionId, context.turnId, source])).digest("hex")}`;
}
function bounded(value: string, max: number): string {
  const safe = String(redactPaperclipSemanticValue(value));
  return safe.length <= max ? safe : `${safe.slice(0, max - 12)} [truncated]`;
}
