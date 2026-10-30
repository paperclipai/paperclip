import { afterEach, expect, it, vi } from "vitest";
import { voiceSessionsApi } from "./voiceSessions";
import { createVoiceCallAttempt, voiceCallJournal } from "../lib/voice-call-attempt";
import { createVoiceSessionController, VoiceSessionStartError } from "../lib/voice-session-controller";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("aborts a stuck notification fetch so the next poll can retrieve the saved answer", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetch = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })).mockResolvedValueOnce(new Response(JSON.stringify({sessionId: "session", generation: 1, publicationId: "saved-answer", attempt: 0}), {headers: {"content-type": "application/json"}}));
  vi.stubGlobal("fetch", fetch);
  const stalled = voiceSessionsApi.notification("company", "session");
  const rejected = expect(stalled).rejects.toMatchObject({name: "AbortError"});
  expect(timeout).toHaveBeenCalledWith(10_000); deadline.abort(); await rejected;
  timeout.mockReturnValue(new AbortController().signal);
  await expect(voiceSessionsApi.notification("company", "session")).resolves.toMatchObject({publicationId: "saved-answer"});
  expect(fetch).toHaveBeenCalledTimes(2);
});

function recoveryJournal() {
  const rows = new Map<string, string>();
  return voiceCallJournal({
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value); },
    removeItem: key => { rows.delete(key); },
  }, "company", "operator");
}
function stalledFetch(_url: string, init: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("Timed out", "TimeoutError")), { once: true });
  });
}
function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
it("bounds lost start responses, preserves the request across reload, and closes the recovered call", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetch = vi.fn().mockImplementationOnce(stalledFetch)
    .mockResolvedValueOnce(jsonResponse({ session: { id: "saved-session", state: "active" } }))
    .mockResolvedValueOnce(jsonResponse({ id: "saved-session", state: "ended" }));
  vi.stubGlobal("fetch", fetch);
  const journal = recoveryJournal();
  const attempt = createVoiceCallAttempt("company", voiceSessionsApi, journal);
  const controller = createVoiceSessionController({
    async mint() { return (await attempt.start({ endpointId: "endpoint", issueId: "task" })).media; },
    async end(id) { await attempt.end(id); },
    connect: vi.fn(),
  });
  const starting = controller.start();
  const stopping = controller.stop();
  expect(controller.getSnapshot().state).toBe("ending");
  expect(timeout).toHaveBeenCalledWith(10_000);
  deadline.abort();
  await Promise.all([starting, stopping]);
  expect(controller.getSnapshot()).toMatchObject({ state: "ended", busy: false });
  const original = journal.read();
  expect(original?.request).toMatchObject({ endpointId: "endpoint", issueId: "task" });
  timeout.mockReturnValue(new AbortController().signal);
  const reloaded = createVoiceCallAttempt("company", voiceSessionsApi, journal);
  await expect(reloaded.start({ endpointId: "other-endpoint" })).rejects.toBeInstanceOf(VoiceSessionStartError);
  expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
  expect(journal.read()?.sessionId).toBe("saved-session");
  await reloaded.end("saved-session");
  expect(journal.read()).toBeUndefined();
});
it("releases stalled hangup into cleanup retry and preserves the exact call identity", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  const media = { sessionId: "saved-session", generation: 1, transportToken: "short-lived", transportUrl: "wss://test.invalid" };
  const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ session: { id: "saved-session", state: "active" }, media }))
    .mockImplementationOnce(stalledFetch)
    .mockResolvedValueOnce(jsonResponse({ id: "saved-session", state: "ended" }));
  vi.stubGlobal("fetch", fetch);
  const journal = recoveryJournal();
  const attempt = createVoiceCallAttempt("company", voiceSessionsApi, journal);
  const localMedia = { endSession: vi.fn(async () => {}), setMicMuted: vi.fn(), sendChatMessage: vi.fn(), startAudioPlayback: vi.fn() };
  const controller = createVoiceSessionController({
    async mint() { return (await attempt.start({ endpointId: "endpoint", issueId: "task" })).media; },
    async end(id) { await attempt.end(id); },
    async connect() { return localMedia; },
  });
  await controller.start();
  timeout.mockReturnValue(deadline.signal);
  const stopping = controller.stop();
  // Cleanup launches remote and local shutdown together.
  await Promise.resolve(); await Promise.resolve();
  expect(timeout).toHaveBeenLastCalledWith(10_000);
  deadline.abort(); await stopping;
  expect(controller.getSnapshot()).toMatchObject({ state: "cleanup_failed", busy: false });
  expect(journal.read()?.sessionId).toBe("saved-session");
  await controller.start(); expect(fetch).toHaveBeenCalledTimes(2);
  timeout.mockReturnValue(new AbortController().signal);
  await controller.stop();
  expect(controller.getSnapshot()).toMatchObject({ state: "ended", busy: false });
  expect(fetch.mock.calls[2][0]).toBe(fetch.mock.calls[1][0]);
  expect(localMedia.endSession).toHaveBeenCalledOnce();
  expect(journal.read()).toBeUndefined();
});
