// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentChatReadProvider, useAgentChatRead } from "./useAgentChatRead";
import { ApiError } from "@/api/client";
const markRead = vi.hoisted(() => vi.fn());
vi.mock("@/api/issues", () => ({ issuesApi: { markRead } }));
let root: Root, container: HTMLDivElement, client: QueryClient;
let focused = true, latest = true, visible = true;
const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
function Message({ id }: { id: string }) {
  const ref = useAgentChatRead(id, "2026-10-30T12:00:00.123Z", true);
  return <div ref={ref}>Digest</div>;
}
async function render(ids = [first], companyId = "company-1", userId = "human-1", issueId = "chat-1") {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <AgentChatReadProvider issueId={issueId} companyId={companyId} userId={userId}>
      <div className="task-chat-scroll-viewport">{ids.map(id => <Message key={id} id={id} />)}</div>
    </AgentChatReadProvider>
  </QueryClientProvider>));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  focused = true; latest = true; visible = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => latest ? 100 : 300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} });
  markRead.mockReset().mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("reads only visible foreground messages at the bottom, including arrivals sharing a millisecond", async () => {
  focused = false; await render(); expect(markRead).not.toHaveBeenCalled();
  focused = true; latest = false; await render(); expect(markRead).not.toHaveBeenCalled();
  latest = true; await render(); expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  await render([first, second]); expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
  await render([first, second]); expect(markRead).toHaveBeenCalledTimes(2);
});
it("does not clear concurrent unseen arrivals while a read request is pending", async () => {
  let finish!: () => void;
  markRead.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); expect(markRead).toHaveBeenCalledTimes(1);
  focused = false; await render([first, second]);
  await act(async () => finish()); expect(markRead).toHaveBeenCalledTimes(1);
  focused = true; await render([first, second]); expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
});
it("automatically retries a failed visible message without another focus event", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new TypeError("Network unavailable"));
  await render();
  expect(markRead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(2);
});
it("retries only the seen cutoff when another message arrives out of view", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new TypeError("Network unavailable"));
  await render();
  focused = false; await render([first, second]);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  focused = true; await render([first, second]);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
});
it("coalesces a newly seen message into the pending retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new TypeError("Network unavailable"));
  await render();
  await render([first, second]);
  expect(markRead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
  await render([first, second]);
  expect(markRead).toHaveBeenCalledTimes(2);
});
it("respects the server retry delay for a rate-limited read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new ApiError("Rate limited", 429, {}, { retryAfterMs: 2_000 }));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
  expect(markRead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(markRead).toHaveBeenCalledTimes(2);
});
it("stops after bounded retries and recovers the retained cutoff on reconnect", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new ApiError("Unavailable", 503, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(markRead).toHaveBeenCalledTimes(3);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t mark this chat read.");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(3);
  markRead.mockResolvedValue({});
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(markRead).toHaveBeenCalledTimes(4);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it.each(["company", "human", "chat", "unmount"])("cancels a pending retry after %s changes", async kind => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new TypeError("Network unavailable"));
  await render();
  expect(markRead).toHaveBeenCalledTimes(1);
  focused = false;
  if (kind === "unmount") await act(async () => { root.render(null); });
  else await render([first], kind === "company" ? "company-2" : "company-1", kind === "human" ? "human-2" : "human-1", kind === "chat" ? "chat-2" : "chat-1");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(1);
});
it("resumes an exhausted cutoff when the chat becomes visible again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new TypeError("Network unavailable"));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(markRead).toHaveBeenCalledTimes(3);
  markRead.mockResolvedValue({});
  visible = false;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(markRead).toHaveBeenCalledTimes(3);
  visible = true;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(markRead).toHaveBeenCalledTimes(4);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
});
it("does not retry a denied read receipt", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new ApiError("Forbidden", 403, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t mark this chat read.");
});
it("discards an in-flight failure after the human changes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let fail!: (cause: Error) => void;
  markRead.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
  await render();
  focused = false; await render([first], "company-1", "human-2");
  await act(async () => { fail(new TypeError("Network unavailable")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
