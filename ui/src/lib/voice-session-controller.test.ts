import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceSessionController, VOICE_REPEAT_NOTIFICATION, VoiceSessionStartError, type VoiceMediaCallbacks, type VoiceMediaCredentials } from "./voice-session-controller";
const credentials: VoiceMediaCredentials = { sessionId: "session-a", generation: 2, transportToken: "short-lived-test-token", transportUrl: "wss://media.example.test" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  let callbacks!: VoiceMediaCallbacks;
  const media = { endSession: vi.fn(async () => {}), setMicMuted: vi.fn(async (_muted: boolean) => {}), sendChatMessage: vi.fn(async (_text: string) => {}), startAudioPlayback: vi.fn(async () => {}) };
  const dependencies = { mint: vi.fn(async () => credentials), end: vi.fn(async (_id: string) => {}), connect: vi.fn(async (_credentials: VoiceMediaCredentials, cb: VoiceMediaCallbacks) => { callbacks = cb; return media; }) };
  return { controller: createVoiceSessionController(dependencies), dependencies, media, callbacks: () => callbacks };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("voice media session lifecycle", () => {
  it("closes a definitively rejected call and explains credits without automatic retry or media", async () => {
    const x=setup();x.dependencies.mint.mockRejectedValue(new VoiceSessionStartError("failed-call","credits_required"));
    await x.controller.start();expect(x.dependencies.connect).not.toHaveBeenCalled();expect(x.dependencies.end).toHaveBeenCalledWith("failed-call");
    expect(x.dependencies.mint).toHaveBeenCalledOnce();expect(x.controller.getSnapshot()).toMatchObject({state:"failed",error:"Speko needs credits before starting a call. Add credits in Speko, then try again."});
  });
  it("closes a session minted after the caller ended without connecting media", async () => {
    const x = setup(); const mint = deferred<VoiceMediaCredentials>(); x.dependencies.mint.mockReturnValue(mint.promise);
    const starting = x.controller.start(); const stopping = x.controller.stop(); expect(x.controller.getSnapshot().state).toBe("ending"); mint.resolve(credentials); await Promise.all([starting, stopping]);
    expect(x.dependencies.connect).not.toHaveBeenCalled(); expect(x.dependencies.end).toHaveBeenCalledExactlyOnceWith("session-a");
    expect(x.controller.getSnapshot().state).toBe("ended");
  });
  it("closes late-connected media and ignores its obsolete callbacks", async () => {
    const x = setup(); const connecting = deferred<typeof x.media>(); let callbacks!: VoiceMediaCallbacks;
    x.dependencies.connect.mockImplementation(async (_credentials, cb) => { callbacks = cb; return connecting.promise; });
    const starting = x.controller.start(); await Promise.resolve(); const stopping = x.controller.stop(); connecting.resolve(x.media); await Promise.all([starting, stopping]);
    callbacks.onModeChange("speaking"); callbacks.onMessage({ source: "agent", text: "stale", segmentId: "x", isFinal: true });
    expect(x.media.endSession).toHaveBeenCalledOnce(); expect(x.controller.getSnapshot()).toMatchObject({ state: "ended", transcript: [] });
  });
  it("fences notifications to the session generation and reserves concurrent duplicates", async () => {
    const x = setup(); await x.controller.start(); const delivery = deferred<void>(); x.media.sendChatMessage.mockReturnValue(delivery.promise);
    const notification = { sessionId: "session-a", generation: 2, publicationId: "result-a" };
    expect(await x.controller.notify({ ...notification, generation: 1 })).toBe(false);
    expect(await x.controller.notify({ ...notification, sessionId: "another-company-session" })).toBe(false);
    const first = x.controller.notify(notification); expect(await x.controller.notify(notification)).toBe(false); delivery.resolve(); expect(await first).toBe(true);
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce(); expect(x.controller.getSnapshot().transcript[0]?.source).toBe("application");
  });
  it("does not replay ambiguous delivery failure or expose private provider errors", async () => {
    const x = setup(); await x.controller.start(); x.media.sendChatMessage.mockRejectedValue(new Error("private provider response"));
    const notification = { sessionId: "session-a", generation: 2, publicationId: "result-a" };
    await x.controller.notify(notification); await x.controller.notify(notification);
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce(); expect(JSON.stringify(x.controller.getSnapshot())).not.toContain("private provider response");
  });
  it("allows a server-authorized later hint after an interruption without duplicating transcript rows", async () => {
    vi.useFakeTimers();
    const x = setup(); await x.controller.start();
    const notification = { sessionId: "session-a", generation: 2, publicationId: "result-a", attempt: 0 };
    expect(await x.controller.notify(notification)).toBe(true);
    expect(await x.controller.notify(notification)).toBe(false);
    x.callbacks().onModeChange("speaking");
    x.callbacks().onModeChange("listening");
    expect(await x.controller.notify({ ...notification, attempt: 1 })).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(x.media.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(x.controller.getSnapshot().transcript).toHaveLength(1);
  });
  it("waits for an acknowledgment to finish before announcing a fast task result", async () => {
    vi.useFakeTimers();
    const x = setup(); await x.controller.start();
    x.callbacks().onModeChange("speaking");
    await x.controller.notify({ sessionId: "session-a", generation: 2, publicationId: "fast-result" });
    expect(x.media.sendChatMessage).not.toHaveBeenCalled();
    x.callbacks().onModeChange("listening");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
  });
  it("coalesces queued result hints and never sends them concurrently", async () => {
    vi.useFakeTimers();
    const x = setup(); await x.controller.start();
    x.callbacks().onModeChange("speaking");
    for (const publicationId of ["one", "two", "three"]) await x.controller.notify({ ...credentials, publicationId });
    const sent = deferred<void>(); x.media.sendChatMessage.mockReturnValue(sent.promise);
    x.callbacks().onModeChange("listening");
    await vi.advanceTimersByTimeAsync(1_500);
    await x.controller.notify({ ...credentials, publicationId: "four" });
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
    sent.resolve(); await Promise.resolve();
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
  });
  it("does not mistake pauses between words for a safe result boundary", async () => {
    vi.useFakeTimers();
    const x = setup(); await x.controller.start();
    await x.controller.notify({ ...credentials, publicationId: "first" });
    x.callbacks().onModeChange("speaking");
    await x.controller.notify({ ...credentials, publicationId: "amended" });
    // The live SDK oscillates even while the first result is being read.
    for (let i = 0; i < 15; i++) {
      x.callbacks().onModeChange("listening");
      await vi.advanceTimersByTimeAsync(800);
      x.callbacks().onMessage({ source: "agent", text: `Result word ${i}`, segmentId: "answer", isFinal: false });
      await vi.advanceTimersByTimeAsync(400);
      x.callbacks().onModeChange("speaking");
    }
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
    x.callbacks().onModeChange("listening");
    await vi.advanceTimersByTimeAsync(1_499);
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
    x.callbacks().onMessage({ source: "agent", text: "The complete result", segmentId: "answer", isFinal: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(x.media.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(x.controller.getSnapshot().state).toBe("listening");
  });
  it("allows a caller interruption to retire unfinished speech before a later result", async () => {
    vi.useFakeTimers();
    const x = setup(); await x.controller.start();
    x.callbacks().onMessage({ source: "agent", text: "An interrupted answer", segmentId: "old-answer", isFinal: false });
    await x.controller.notify({ ...credentials, publicationId: "next" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(x.media.sendChatMessage).not.toHaveBeenCalled();
    x.callbacks().onMessage({ source: "user", text: "Please include the other instruction", segmentId: "followup", isFinal: true });
    // A delayed native transcript for the interrupted turn must not reopen
    // its gate after the caller has already moved on.
    x.callbacks().onMessage({ source: "agent", text: "An interrupted answer, delayed fragment", segmentId: "old-answer", isFinal: false });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
    expect(x.controller.getSnapshot().transcript[0]?.final).toBe(false);
  });
  it("clears queued hints when a call ends during the quiet period", async () => {
    vi.useFakeTimers();
    const x = setup(); await x.controller.start();
    x.callbacks().onModeChange("speaking");
    await x.controller.notify({ ...credentials, publicationId: "pending" });
    x.callbacks().onModeChange("listening");
    await x.controller.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(x.media.sendChatMessage).not.toHaveBeenCalled();
  });
  it("discards an obsolete queued hint when the server reports no undelivered result", async () => {
    vi.useFakeTimers();
    const x = setup(); await x.controller.start();
    await x.controller.notify({ ...credentials, publicationId: "result" });
    await x.controller.notify({ ...credentials, publicationId: "result", attempt: 1 });
    x.controller.clearPendingNotifications();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
  });
  it("repeats only on caller action without creating another session or task request", async () => {
    const x = setup();
    await x.controller.repeat(); expect(x.media.sendChatMessage).not.toHaveBeenCalled();
    await x.controller.start();
    await x.controller.notify({ ...credentials, publicationId: "result" });
    x.callbacks().onModeChange("speaking");
    const sent = deferred<void>(); x.media.sendChatMessage.mockReturnValueOnce(sent.promise);
    const repeating = x.controller.repeat(); await x.controller.repeat();
    expect(x.media.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(x.media.sendChatMessage).toHaveBeenLastCalledWith(VOICE_REPEAT_NOTIFICATION);
    sent.resolve(); await repeating;
    expect(x.dependencies.mint).toHaveBeenCalledOnce();
    await x.controller.stop(); await x.controller.repeat();
    expect(x.media.sendChatMessage).toHaveBeenCalledTimes(2);
  });
  it("changes mute state after media succeeds, rejecting double clicks", async () => {
    const x = setup(); await x.controller.start(); const muting = deferred<void>(); x.media.setMicMuted.mockReturnValue(muting.promise);
    const first = x.controller.mute(); await x.controller.mute(); expect(x.controller.getSnapshot().muted).toBe(false);
    muting.resolve(); await first; expect(x.controller.getSnapshot().muted).toBe(true); expect(x.media.setMicMuted).toHaveBeenCalledOnce();
  });
  it("announces committed speech, not each partial or repeated final", async () => {
    const x = setup(); await x.controller.start();
    x.callbacks().onMessage({ source: "agent", segmentId: "a", text: "One", isFinal: false }); expect(x.controller.getSnapshot().announcement).toBe("");
    x.callbacks().onMessage({ source: "agent", segmentId: "a", text: "One result", isFinal: true }); const announcement = x.controller.getSnapshot().announcement;
    x.callbacks().onMessage({ source: "agent", segmentId: "a", text: "One result", isFinal: true });
    expect(x.controller.getSnapshot().announcement).toBe(announcement); expect(x.controller.getSnapshot().transcript).toHaveLength(1);
  });
  it("joins simultaneous stops and blocks a new start until cleanup completes", async () => {
    const x = setup(); await x.controller.start(); const closing = deferred<void>(); x.dependencies.end.mockReturnValue(closing.promise);
    const first = x.controller.stop(); const second = x.controller.stop(); await x.controller.start();
    expect(first).toBe(second); expect(x.dependencies.mint).toHaveBeenCalledOnce(); expect(x.controller.getSnapshot().state).toBe("ending");
    closing.resolve(); await first; expect(x.dependencies.end).toHaveBeenCalledOnce();
  });
  it("retries failed remote cleanup without closing media twice or starting another call", async () => {
    const x = setup(); await x.controller.start(); x.dependencies.end.mockRejectedValueOnce(new Error("provider unavailable"));
    await x.controller.stop(); expect(x.controller.getSnapshot().state).toBe("cleanup_failed"); await x.controller.start(); expect(x.dependencies.mint).toHaveBeenCalledOnce();
    await x.controller.stop(); expect(x.controller.getSnapshot().state).toBe("ended"); expect(x.media.endSession).toHaveBeenCalledOnce(); expect(x.dependencies.end).toHaveBeenCalledTimes(2);
  });
  it("preserves an early speaking callback during connection", async () => {
    const x = setup(); x.dependencies.connect.mockImplementation(async (_credentials, cb) => { cb.onModeChange("speaking"); return x.media; });
    await x.controller.start(); expect(x.controller.getSnapshot().state).toBe("speaking");
  });
  it("reconciles unsegmented partials and announces their final", async () => {
    const x = setup(); await x.controller.start();
    x.callbacks().onMessage({ source: "agent", text: "A", isFinal: false });
    x.callbacks().onMessage({ source: "agent", text: "A result", isFinal: true });
    x.callbacks().onMessage({ source: "agent", text: "A result", isFinal: true });
    expect(x.controller.getSnapshot().transcript).toHaveLength(1); expect(x.controller.getSnapshot().announcement).toBe("Agent: A result");
  });
  it("ends media and provider once without cancelling execution", async () => {
    const x = setup(); await x.controller.start(); await x.controller.stop(); await x.controller.stop();
    expect(x.media.endSession).toHaveBeenCalledOnce(); expect(x.dependencies.end).toHaveBeenCalledExactlyOnceWith("session-a");
  });
  it("queues a result notification received while media is still connecting", async () => {
    const x = setup(), connecting = deferred<typeof x.media>();
    x.dependencies.connect.mockReturnValue(connecting.promise);
    const start = x.controller.start();
    await Promise.resolve();
    await x.controller.notify({ sessionId: credentials.sessionId, generation: credentials.generation, publicationId: "early-result" });
    expect(x.media.sendChatMessage).not.toHaveBeenCalled();
    connecting.resolve(x.media);
    await start;
    expect(x.media.sendChatMessage).toHaveBeenCalledOnce();
  });
  it("retains a call identity for cleanup when creation returned no media token", async () => {
    const x = setup();
    x.dependencies.mint.mockRejectedValue(new VoiceSessionStartError("uncertain-session"));
    x.dependencies.end.mockRejectedValueOnce(new Error("Still ending"));
    await x.controller.start();
    expect(x.dependencies.connect).not.toHaveBeenCalled();
    expect(x.controller.getSnapshot().state).toBe("cleanup_failed");
    await x.controller.start();
    expect(x.dependencies.mint).toHaveBeenCalledOnce();
    await x.controller.stop();
    expect(x.dependencies.end).toHaveBeenLastCalledWith("uncertain-session");
    expect(x.controller.getSnapshot().state).toBe("ended");
  });

});
