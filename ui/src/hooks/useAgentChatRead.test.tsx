// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentChatReadProvider, useAgentChatRead } from "./useAgentChatRead";
const markRead = vi.hoisted(() => vi.fn());
vi.mock("@/api/issues", () => ({ issuesApi: { markRead } }));
let root: Root, container: HTMLDivElement, client: QueryClient;
let focused = true, latest = true;
const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
function Message({ id }: { id: string }) {
  const ref = useAgentChatRead(id, "2026-10-30T12:00:00.123Z", true);
  return <div ref={ref}>Digest</div>;
}
async function render(ids = [first], companyId = "company-1") {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <AgentChatReadProvider issueId="chat-1" companyId={companyId} userId="human-1">
      <div className="task-chat-scroll-viewport">{ids.map(id => <Message key={id} id={id} />)}</div>
    </AgentChatReadProvider>
  </QueryClientProvider>));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  focused = true; latest = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => latest ? 100 : 300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} });
  markRead.mockReset().mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
