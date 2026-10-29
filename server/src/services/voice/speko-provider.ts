import type { spekoToolDefinitions } from "./speko-protocol.js";
import { z } from "zod";
import { parseSpekoCallReport } from "./speko-call-report.js";
import { logger } from "../../middleware/logger.js";
import { parseSpekoDeliveryDiagnostics } from "./speko-delivery-diagnostics.js";
import { PHONE_VOICE_PROMPT } from "./voice-prompts.js";

const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const mediaUrl = z.string().url().refine((value) => { const url = new URL(value); return url.protocol === "wss:" && !url.username && !url.password; });
const sessionSchema = z.object({ sessionId: providerId, transportToken: z.string().min(1).max(32_000), transportUrl: mediaUrl });
export type SpekoBrowserSession = z.infer<typeof sessionSchema>;
export class SpekoProviderError extends Error {
  constructor(readonly code: "credentials_rejected" | "insufficient_credits" | "rate_limited" | "provider_unavailable" | "invalid_response", readonly outcomeUnknown: boolean, readonly httpStatus?: number) {
    super(`Speko ${code}`);
  }
}

/** Server-only hosted transport. Never retries a mutation or follows redirects. */
export function createSpekoProvider(apiKey: string, transport: typeof fetch = fetch) {
  if (!apiKey.trim()) throw new Error("Speko API credential is required");
  async function request(path: string, body?: unknown, method?: "PATCH", timeoutMs = 20_000, onResponse?: (status: number) => void) {
    let response: Response;
    try {
      response = await transport(`https://api.speko.dev${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"), redirect: "error",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new SpekoProviderError("provider_unavailable", body !== undefined); }
    onResponse?.(response.status);
    if (!response.ok) {
      await response.body?.cancel();
      throw new SpekoProviderError(response.status === 401 || response.status === 403 ? "credentials_rejected" : response.status === 402 ? "insufficient_credits" : response.status === 429 ? "rate_limited" : "provider_unavailable", body !== undefined && response.status >= 500, response.status);
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing body");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > 1024 * 1024) throw new Error("Response too large"); chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch { throw new SpekoProviderError("invalid_response", body !== undefined); }
  }
  function pathId(id: string) { return encodeURIComponent(providerId.parse(id)); }
  return {
    async listTools(agentId: string) {
      const result = await request(`/v1/agents/${pathId(agentId)}/tools`);
      const parsed = z.array(z.object({ id: providerId, name: z.string(), source: z.object({ kind: z.string(), url: z.string().optional() }) })).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", false);
      return parsed.data;
    },
    async configureTool(agentId: string, tool: ReturnType<typeof spekoToolDefinitions>[number], signingSecret: string, toolId?: string) {
      const result = await request(`/v1/agents/${pathId(agentId)}/tools${toolId ? `/${pathId(toolId)}` : ""}`, { ...tool, source: { ...tool.source, secret: signingSecret } }, toolId ? "PATCH" : undefined);
      const parsed = z.object({ id: providerId }).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", true);
      return parsed.data;
    },
    async verifyAgent(agentId: string) {
      const result = await request(`/v1/agents/${pathId(agentId)}`);
      const parsed = z.object({ id: providerId, organizationId: providerId, name: z.string().min(1).max(500) }).safeParse(result);
      if (!parsed.success || parsed.data.id !== agentId) throw new SpekoProviderError("invalid_response", false);
      return parsed.data;
    },
    async configureVoiceDefaults(agentId: string) {
      // Incoming calls inherit realtime mode; browser creation explicitly uses
      // cascade. Browser sessions do not dispatch pre-call hooks, so the persona
      // default must keep idle prompts off. Telephone hooks enable them per call.
      await request(`/v1/agents/${pathId(agentId)}`, {runMode: "s2s", systemPrompt: PHONE_VOICE_PROMPT, idleRePrompts: {enabled: false}}, "PATCH");
    },
    async createBrowserSession(input: { agentId: string; maxDurationSeconds: number; bindingId: string; toolToken: string; systemPrompt: string }) {
      const maxDurationSeconds = z.number().int().min(30).max(1800).parse(input.maxDurationSeconds);
      const result = await request("/v1/sessions", {
        mode: "cascade", agentId: providerId.parse(input.agentId), ttlSeconds: 120, maxDurationSeconds,
        systemPrompt: input.systemPrompt,
        firstMessage: "Hi, what would you like me to work on?",
        metadata: { paperclipVoiceBindingId: input.bindingId },
        toolSecrets: { paperclip_session_token: input.toolToken },
      });
      const parsed = sessionSchema.safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", true);
      return parsed.data;
    },
    async createPhoneSession(input: { agentId: string; maxDurationSeconds: number; bindingId: string; toolToken: string; systemPrompt: string; to: string }) {
      const agentId = providerId.parse(input.agentId);
      const to = z.string().regex(/^\+[1-9]\d{6,14}$/).parse(input.to);
      const maxDurationSeconds = z.number().int().min(30).max(1800).parse(input.maxDurationSeconds);
      // Per-call signed pre-call overrides bind automatic reply delivery. Never mutate
      // the shared persona during dialing: browser sessions use result hints.
      const result = await request("/v1/sessions/phone", {
        runMode: "s2s",
        agentId, to, maxDurationSeconds,
        systemPrompt: input.systemPrompt, firstMessage: "Hi, this is your Paperclip agent calling as requested. Is now a good time?",
        metadata: { paperclipVoiceBindingId: input.bindingId },
        toolSecrets: { paperclip_session_token: input.toolToken },
        telephony: { amd: { mode: "disabled" } },
        turnHandling: { profile: "conversational", onMachine: "hangup" },
      });
      const parsed = z.object({ sessionId: providerId, status: z.enum(["dialing", "dialing-stub"]) }).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", true);
      if (parsed.data.status === "dialing-stub") throw new SpekoProviderError("provider_unavailable", false);
      return parsed.data;
    },
    async inspectSession(sessionId: string) {
      const result = await request(`/v1/calls/${pathId(sessionId)}`);
      const parsed = z.object({ status: z.string(), endedAt: z.string().nullable().optional(), ended_at: z.string().nullable().optional() }).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", false);
      return { status: parsed.data.status, endedAt: parsed.data.endedAt ?? parsed.data.ended_at ?? null };
    },
    async listPhoneNumbers() {
      const result = await request("/v1/phone-numbers");
      const parsed = z.array(z.object({ id: providerId, organizationId: providerId, e164: z.string().regex(/^\+[1-9]\d{6,14}$/), label: z.string().nullable(), agentId: providerId.nullable(), routeToBrokerId: z.string().nullable().optional(), suspendedAt: z.string().nullable(),
        direction: z.enum(["inbound", "outbound", "both"]), setupStatus: z.object({ status: z.enum(["ready", "action_required", "suspended"]), inboundReady: z.boolean(), outboundReady: z.boolean(), issues: z.array(z.string().max(500)).max(30) }) })).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", false);
      return parsed.data;
    },
    async assignPhoneNumber(numberId: string, agentId: string) {
      await request(`/v1/phone-numbers/${pathId(numberId)}`, { agentId: providerId.parse(agentId) }, "PATCH");
    },
    async listWebhooks() {
      const result = await request("/v1/webhooks");
      const parsed = z.object({data: z.array(z.object({id: providerId, url: z.string().url(), events: z.array(z.string()), allAgents: z.boolean(), agentIds: z.array(providerId), filterTags: z.record(z.string(), z.string())}))}).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", false);
      return parsed.data.data;
    },
    async configureWebhook(agentId: string, url: string, secret: string, webhookId?: string) {
      const callback = new URL(url);
      if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash || callback.search) throw new Error("Public HTTPS callback required");
      const result = await request(`/v1/webhooks${webhookId ? `/${pathId(webhookId)}` : ""}`, { name: "Paperclip voice calls", url: callback.href, events: ["call.pre_call", "call.status", "call.report"], allAgents: false, agentIds: [providerId.parse(agentId)], timeoutMs: 3500, signingSecretSource: "custom", signingSecret: secret }, webhookId ? "PATCH" : undefined);
      const parsed = z.object({id: providerId}).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", true);
      return parsed.data;
    },
    async callReport(sessionId: string, secrets: readonly string[] = []) {
      const result = await request(`/v1/calls/${pathId(sessionId)}`);
      try { return parseSpekoCallReport(result, sessionId, [apiKey, ...secrets]); }
      catch { throw new SpekoProviderError("invalid_response", false); }
    },
    async callDeliveryDiagnostics(sessionId: string, deliveries: readonly {messageId: string; acceptedAt: string}[]) {
      const id = pathId(sessionId);
      try {
        const [call, events] = await Promise.all([
          request(`/v1/calls/${id}`, undefined, undefined, 5000),
          request(`/v1/calls/${id}/events`, undefined, undefined, 5000),
        ]);
        return parseSpekoDeliveryDiagnostics(call, events, sessionId, deliveries);
      } catch (error) {
        if (error instanceof SpekoProviderError) throw error;
        throw new SpekoProviderError("invalid_response", false);
      }
    },
    async sendCallMessage(sessionId: string, text: string, mode: "respond" | "context" = "respond") {
      const body = z.object({text: z.string().trim().min(1).max(16000), mode: z.enum(["respond", "context"])}).parse({text, mode});
      const id = pathId(sessionId), startedAt = Date.now();
      let httpStatus: number | null = null;
      try {
        const result = await request(`/v1/calls/${id}/messages`, body, undefined, 5000, status => { httpStatus = status; });
        const parsed = z.object({message_id: providerId}).safeParse(result);
        if (!parsed.success) throw new SpekoProviderError("invalid_response", true);
        logger.info({event: "voice.reply.push.http_accepted", providerSessionId: sessionId, messageId: parsed.data.message_id,
          mode, httpStatus, durationMs: Date.now() - startedAt, playback: "unknown"}, "Speko accepted live-call message");
        return {messageId: parsed.data.message_id};
      } catch (error) {
        logger.warn({event: "voice.reply.push.http_failed", providerSessionId: sessionId, mode, httpStatus,
          durationMs: Date.now() - startedAt, errorCode: error instanceof SpekoProviderError ? error.code : "invalid_request",
          outcomeUnknown: error instanceof SpekoProviderError ? error.outcomeUnknown : false}, "Speko live-call message request failed");
        throw error;
      }
    },
    async endSession(sessionId: string) {
      const result = await request(`/v1/calls/${pathId(sessionId)}/end`, {});
      const parsed = z.object({ status: z.enum(["ending", "already_ended"]) }).safeParse(result);
      if (!parsed.success) throw new SpekoProviderError("invalid_response", true);
      // "ending" is a request receipt, not confirmation of room teardown.
      return { confirmed: parsed.data.status === "already_ended" };
    },
  };
}
