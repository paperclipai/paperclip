import { z } from "zod";
import { VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION, type VoiceTranscriptEntry } from "@paperclipai/shared";
import { redactSensitiveText } from "../../redaction.js";
const timestamp = z.string().datetime({ offset: true });
const entry = z.object({
  id: z.string().min(1).max(200), index: z.number().int().nonnegative(),
  source: z.enum(["user", "agent", "system"]), text: z.string().max(32_000),
  // Live call detail uses snake_case; finalized report turns use camelCase.
  started_at: timestamp.optional(), ended_at: timestamp.nullable().optional(),
  startedAt: timestamp.optional(), endedAt: timestamp.nullable().optional(),
  latency_status: z.string().nullable().optional(),
}).refine(value => Boolean(value.started_at ?? value.startedAt), {message: "Spoken turn requires a timestamp", path: ["started_at"]})
  .transform(value => ({...value, started_at: value.started_at ?? value.startedAt!, ended_at: value.ended_at !== undefined ? value.ended_at : value.endedAt ?? null}));
const transcript = z.object({ entries: z.array(entry).max(2000) });
const schema = z.object({
  id: z.string().optional(), call_id: z.string().optional(),
  duration_seconds: z.number().finite().nonnegative().max(2_147_483_647).nullable().optional(),
  updated_at: timestamp.optional(),
  transcript: transcript.optional(),
  report: z.object({ session_id: z.string(), transcript,
    cost_micro_usd: z.string().regex(/^[0-9]{1,30}$/).nullable().optional(),
    updated_at: timestamp,
  }).nullable().optional(),
});
export interface SpekoCallReport {
  complete: boolean;
  transcript: VoiceTranscriptEntry[];
  costMicroUsd: string | null;
  durationSeconds: number | null;
  providerUpdatedAt: Date | null;
}
/** Allowlist only spoken turns. System turns, traces, recordings and arbitrary metadata are excluded. */
export function parseSpekoCallReport(value: unknown, sessionId: string, secrets: readonly string[] = []): SpekoCallReport {
  const parsed = schema.parse(value);
  if ((parsed.id && parsed.id !== sessionId) || (parsed.call_id && parsed.call_id !== sessionId) || (parsed.report && parsed.report.session_id !== sessionId)) throw new Error("Mismatched Speko call report");
  const entries = parsed.report?.transcript.entries ?? parsed.transcript?.entries ?? [];
  const byId = new Map<string, VoiceTranscriptEntry>();
  for (const e of entries) {
    if (e.source === "system" || e.source === "user" && [VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION].includes(e.text)) continue;
    let text = e.text;
    for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
    byId.set(e.id, { id: e.id, index: e.index, speaker: e.source === "user" ? "caller" : "agent", text: redactSensitiveText(text), startedAt: e.started_at, endedAt: e.ended_at, interrupted: e.latency_status === "interrupted" });
  }
  return { complete: Boolean(parsed.report), transcript: [...byId.values()].sort((a,b) => a.index - b.index || a.id.localeCompare(b.id)), costMicroUsd: parsed.report?.cost_micro_usd ?? null,
    durationSeconds: parsed.duration_seconds == null ? null : Math.round(parsed.duration_seconds), providerUpdatedAt: parsed.report ? new Date(parsed.report.updated_at) : parsed.updated_at ? new Date(parsed.updated_at) : null };
}
