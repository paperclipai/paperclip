import { describe, expect, it, vi } from "vitest";
import type { voiceSessionsApi } from "@/api/voiceSessions";
import type { VoiceSession, VoiceSessionMedia } from "@paperclipai/shared";
import { createVoiceCallAttempt, voiceCallJournal } from "./voice-call-attempt";
import { ApiError } from "@/api/client";
import { VoiceSessionStartError } from "./voice-session-controller";

function fixture() {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const session = { id: "session", state: "active" } as VoiceSession;
  const media = { sessionId: "session", generation: 1, transportToken: "must-never-be-saved", transportUrl: "wss://test.invalid" } satisfies VoiceSessionMedia;
  const client = { start: vi.fn(async (..._args: Parameters<typeof voiceSessionsApi.start>) => ({ session, media })), end: vi.fn(async () => ({ ...session, state: "ended" as const })), get: vi.fn(async () => session), notification: vi.fn(async () => null) };
  const journal = voiceCallJournal(storage, "company", "operator");
  return { rows, storage, client, journal };
}
describe("voice reload recovery", () => {
  it.each([400, 401, 403, 404, 422])("allows a new endpoint after definitive admission rejection %s", async (status) => {
    const f = fixture();
    f.client.start.mockRejectedValueOnce(new ApiError("Rejected", status, {error: "Rejected"}));
    const attempt = createVoiceCallAttempt("company", f.client, f.journal);
    await expect(attempt.start({endpointId: "stale"})).rejects.toBeInstanceOf(ApiError);
    expect(f.journal.read()).toBeUndefined();
    await attempt.start({endpointId: "valid", issueId: "new-task"});
    expect(f.client.start.mock.calls[1]?.[1]).toMatchObject({endpointId: "valid", issueId: "new-task"});
    expect(f.client.start.mock.calls[1]?.[1].idempotencyKey).not.toBe(f.client.start.mock.calls[0]?.[1].idempotencyKey);
  });
  it("retains exact cleanup identity and a safe credit reason after a rejected creation", async () => {
    const f=fixture();f.client.start.mockRejectedValue(new ApiError("private provider detail",409,{details:{code:"voice_credits_required",sessionId:"failed-call"}}));
    const attempt=createVoiceCallAttempt("company",f.client,f.journal);
    await expect(attempt.start({endpointId:"endpoint"})).rejects.toMatchObject({sessionId:"failed-call",reason:"credits_required"});
    expect(f.client.start).toHaveBeenCalledOnce();expect(f.journal.read()?.sessionId).toBe("failed-call");
    await attempt.end("failed-call");expect(f.journal.read()).toBeUndefined();
  });
  it("closes the saved call on reload without minting or reissuing media", async () => {
    const f = fixture();
    const original = createVoiceCallAttempt("company", f.client, f.journal);
    await original.start({ endpointId: "endpoint", issueId: "task" });
    expect([...f.rows.values()].join()).not.toContain("must-never-be-saved");
    const reloaded = createVoiceCallAttempt("company", f.client, f.journal);
    await expect(reloaded.start({ endpointId: "different-endpoint" })).rejects.toMatchObject({ sessionId: "session" });
    expect(f.client.start).toHaveBeenCalledOnce();
    await reloaded.end("session"); expect(f.journal.read()).toBeUndefined();
    await reloaded.start({ endpointId: "different-endpoint" }); expect(f.client.start).toHaveBeenCalledTimes(2);
  });
  it("recovers a lost creation response using the original key and exact task intent", async () => {
    const f = fixture(); f.client.start.mockRejectedValueOnce(new Error("Lost response"));
    await expect(createVoiceCallAttempt("company", f.client, f.journal).start({ endpointId: "endpoint", newConversation: true })).rejects.toThrow("Lost response");
    const reloaded = createVoiceCallAttempt("company", f.client, f.journal);
    await expect(reloaded.start({ endpointId: "different", issueId: "other-task" })).rejects.toBeInstanceOf(VoiceSessionStartError);
    expect(f.client.start.mock.calls[0]).toEqual(f.client.start.mock.calls[1]);
    await reloaded.end("session");
  });
  it("preserves recovery across an uncertain hangup and isolates company/user scopes", async () => {
    const f = fixture(); const attempt = createVoiceCallAttempt("company", f.client, f.journal);
    await attempt.start({ endpointId: "endpoint" });
    f.client.end.mockRejectedValueOnce(new Error("Unconfirmed"));
    await expect(attempt.end("session")).rejects.toThrow("Unconfirmed");
    expect(f.journal.read()?.sessionId).toBe("session");
    expect(voiceCallJournal(f.storage, "other-company", "operator").read()).toBeUndefined();
    expect(voiceCallJournal(f.storage, "company", "another-user").read()).toBeUndefined();
    await attempt.end("session"); expect(f.journal.read()).toBeUndefined();
  });
  it("does not open a provider call if recovery identity cannot be persisted", async () => {
    const f = fixture(); const journal = { ...f.journal, write() { throw new Error("Storage unavailable"); } };
    await expect(createVoiceCallAttempt("company", f.client, journal).start({ endpointId: "endpoint" })).rejects.toThrow("Storage unavailable");
    expect(f.client.start).not.toHaveBeenCalled();
  });
  it("still identifies the exact call for cleanup if storage fails after creation", async () => {
    const f = fixture(); let writes = 0;
    const journal = { ...f.journal, write: (value: Parameters<typeof f.journal.write>[0]) => { if (++writes > 1) throw new Error("Storage full"); f.journal.write(value); } };
    await expect(createVoiceCallAttempt("company", f.client, journal).start({ endpointId: "endpoint" })).rejects.toMatchObject({ sessionId: "session" });
  });
});
