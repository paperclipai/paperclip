import { z } from "zod";
import { parseSpekoCallReport } from "./speko-call-report.js";

const timestamp = z.string().datetime({ offset: true });
const eventSchema = z.object({ events: z.array(z.object({
  session_id: z.string().optional(), event_type: z.string(),
  occurred_at: timestamp.optional(), created_at: timestamp.optional(),
  status: z.unknown().optional(), payload: z.unknown().optional(),
})).max(2000) });
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function choice<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === "string" && values.includes(value as T) ? value as T : null;
}
function integer(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function date(value: unknown) { const parsed = timestamp.safeParse(value); return parsed.success ? parsed.data : null; }

/** Closed, content-free projection. Never retain prompts, transcript text, tool
 * headers, phone numbers, recording URLs or arbitrary provider trace payloads. */
export function parseSpekoDeliveryDiagnostics(call: unknown, events: unknown, sessionId: string, deliveries: readonly {messageId: string; acceptedAt: string}[]) {
  const report = parseSpekoCallReport(call, sessionId);
  const rows = eventSchema.parse(events).events;
  if (rows.some(row => row.session_id && row.session_id !== sessionId)) throw new Error("Mismatched Speko diagnostic event");
  const detail = record(call), pipeline = record(detail.pipeline_config), s2s = record(pipeline.s2s), idle = record(pipeline.idleRePrompts);
  const started = rows.find(row => row.event_type === "worker.duplex.started");
  const worker = record(record(started?.payload).data);
  const prompt = typeof pipeline.systemPrompt === "string" ? pipeline.systemPrompt : "";
  const nestedPrompt = typeof s2s.systemPrompt === "string" ? s2s.systemPrompt : "";
  const toolNames = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(item => choice(record(item).name, ["submit_request", "get_updates", "answer_question"] as const)).filter((name): name is "submit_request" | "get_updates" | "answer_question" => name !== null))] : [];
  const agentTurns = report.transcript.filter(turn => turn.speaker === "agent");
  return {
    callStatus: choice(detail.status, ["active", "connecting", "dialing", "ended", "failed", "completed"] as const),
    endedAt: date(detail.ended_at ?? detail.endedAt),
    providerUpdatedAt: report.providerUpdatedAt?.toISOString() ?? null,
    transcriptComplete: report.complete,
    agentTurnCount: agentTurns.length,
    callerTurnCount: report.transcript.filter(turn => turn.speaker === "caller").length,
    runtime: {
      duplexStartedAt: started?.occurred_at ?? started?.created_at ?? null,
      provider: choice(worker.provider, ["openai", "google", "xai"] as const),
      model: choice(worker.model, ["gpt-live-1", "gpt-realtime-2.1", "gpt-realtime", "gemini-3.1-flash-live-preview", "grok-voice-latest"] as const),
      backendModel: choice(worker.backendModel, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-luna", "gpt-6-sol"] as const),
      sipInbound: typeof worker.sipInbound === "boolean" ? worker.sipInbound : null,
      toolCount: integer(worker.toolCount),
      fallbackObserved: rows.some(row => row.event_type === "s2s.fallback"),
    },
    configuration: {
      kind: choice(pipeline.kind, ["s2s", "cascade"] as const),
      topLevelPromptCharacters: prompt.length, s2sPromptCharacters: nestedPrompt.length,
      promptsMatch: prompt && nestedPrompt ? prompt === nestedPrompt : null,
      automaticPushInstruction: prompt.includes("Paperclip pushes approved task answers"),
      topLevelTools: toolNames(pipeline.tools), s2sTools: toolNames(s2s.tools),
      idleRepromptsEnabled: typeof idle.enabled === "boolean" ? idle.enabled : null,
      idleRepromptDelayMs: integer(idle.delayMs), idleRepromptMaxPrompts: integer(idle.maxPrompts),
    },
    messages: deliveries.map(delivery => {
      const acceptedAt = timestamp.parse(delivery.acceptedAt);
      const matched = rows.filter(row => row.event_type === "call.message_sent" && record(row.payload).messageId === delivery.messageId);
      const after = agentTurns.filter(turn => Date.parse(turn.startedAt) >= Date.parse(acceptedAt)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      const working = after.filter(turn => /^i['’]m still working on it[.!]?$/i.test(turn.text.trim()));
      return {
        messageId: delivery.messageId, acceptedAt,
        providerMessageEventCount: matched.length,
        providerMessageEventAt: matched[0]?.occurred_at ?? matched[0]?.created_at ?? null,
        providerMessageEventStatus: choice(matched[0]?.status, ["pending", "accepted", "delivered", "completed", "failed"] as const),
        agentTurnsAfterAcceptance: after.length, workingRepromptsAfterAcceptance: working.length,
        firstAgentTurnAfterAcceptanceAt: after[0]?.startedAt ?? null,
        lastAgentTurnAfterAcceptanceAt: after.at(-1)?.startedAt ?? null,
        // Transcript activity and an accepted event do not establish playback.
        playback: "unknown" as const,
      };
    }),
  };
}
export type SpekoDeliveryDiagnostics = ReturnType<typeof parseSpekoDeliveryDiagnostics>;
