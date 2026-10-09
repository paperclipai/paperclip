import { afterEach, expect, it, vi } from "vitest";
import { voiceSessionsApi } from "./voiceSessions";

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
