import type { voiceSessionsApi } from "@/api/voiceSessions";
import { ApiError } from "@/api/client";
import { VoiceSessionStartError } from "./voice-session-controller";

type StartInput = Parameters<typeof voiceSessionsApi.start>[1];
export interface VoiceCallAttempt { request: StartInput; sessionId?: string }
export interface VoiceCallJournal {
  read(): VoiceCallAttempt | undefined;
  write(attempt: VoiceCallAttempt): void;
  clear(): void;
}

/** Tab-scoped recovery identity only. Never persist media tokens or transcripts. */
export function voiceCallJournal(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, companyId: string, callerId: string): VoiceCallJournal {
  const key = `paperclip:voice-attempt:${encodeURIComponent(companyId)}:${encodeURIComponent(callerId)}`;
  return {
    read() {
      const raw = storage.getItem(key);
      if (!raw) return undefined;
      if (raw.length > 4096) throw new Error("Invalid voice recovery identity");
      const value = JSON.parse(raw) as VoiceCallAttempt;
      if (!value || typeof value.request?.endpointId !== "string" || typeof value.request.idempotencyKey !== "string"
        || value.sessionId !== undefined && typeof value.sessionId !== "string") throw new Error("Invalid voice recovery identity");
      return value;
    },
    write({ request, sessionId }) {
      storage.setItem(key, JSON.stringify({ request: { endpointId: request.endpointId, issueId: request.issueId,
        newConversation: request.newConversation, idempotencyKey: request.idempotencyKey, maxDurationSeconds: request.maxDurationSeconds }, sessionId }));
    },
    clear() { storage.removeItem(key); },
  };
}

/** Recover an uncertain request with the SAME input/key, then close its exact call. */
export function createVoiceCallAttempt(companyId: string, client: typeof voiceSessionsApi, journal?: VoiceCallJournal) {
  let attempt: VoiceCallAttempt | undefined;
  let recovering = false;
  return {
    async start(input: Omit<StartInput, "idempotencyKey">) {
      if (!attempt) {
        attempt = journal?.read();
        recovering = Boolean(attempt);
        attempt ??= { request: { ...input, idempotencyKey: crypto.randomUUID() } };
      }
      // A storage failure must occur before the provider can open a call.
      journal?.write(attempt);
      if (attempt.sessionId) throw new VoiceSessionStartError(attempt.sessionId);
      let result: Awaited<ReturnType<typeof client.start>>;
      try { result = await client.start(companyId, attempt.request); }
      catch (error) {
        const body = error instanceof ApiError ? error.body as { details?: { sessionId?: string; code?: string } } | null : null;
        if (body?.details?.sessionId) {
          attempt.sessionId = body.details.sessionId;
          try { journal?.write(attempt); } catch { /* Exact identity still reaches cleanup. */ }
          throw new VoiceSessionStartError(attempt.sessionId, body.details.code === "voice_credits_required" ? "credits_required" : undefined);
        }
        if (error instanceof ApiError && [400, 401, 403, 404, 422].includes(error.status)) {
          // These responses reject admission before creating a provider call.
          // Network errors and ambiguous provider outcomes keep their identity.
          journal?.clear(); attempt = undefined; recovering = false;
        }
        throw error;
      }
      attempt.sessionId = result.session.id;
      // If persisting the identity fails after creation, the controller still
      // receives the exact call to close; never lose a live provider resource.
      try { journal?.write(attempt); }
      catch { throw new VoiceSessionStartError(attempt.sessionId); }
      if (recovering || !result.media) throw new VoiceSessionStartError(attempt.sessionId);
      return { ...result, media: result.media };
    },
    async end(sessionId: string) {
      const result = await client.end(companyId, sessionId);
      if (!["ended", "failed", "expired"].includes(result.state)) throw new Error("Speko has not confirmed hangup yet");
      const saved = journal?.read();
      if (!saved || saved.sessionId === sessionId || saved.request.idempotencyKey === attempt?.request.idempotencyKey) journal?.clear();
      attempt = undefined; recovering = false;
    },
  };
}
