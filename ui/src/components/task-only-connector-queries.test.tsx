// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailTaskActivity } from "./EmailTaskActivity";
import { useIssueChatBinding } from "./chat/ExternallyConnectedTaskBanner";

const api = vi.hoisted(() => ({ getIssueBinding: vi.fn(), thread: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: api }));
vi.mock("@/api/email", () => ({ emailApi: api }));
vi.mock("@/hooks/useChatConnectorsEnabled", () => ({
  useChatConnectorsEnabled: () => ({ enabled: true, loaded: true }),
}));

const companyId = "test-company";
const taskId = "22222222-2222-4222-8222-222222222222";
const chatId = `chat:${taskId}`;

function ConnectorQueries({ issueId }: { issueId: string }) {
  const { binding, isLoading } = useIssueChatBinding(companyId, issueId);
  return <>
    <output>{binding ? "bound" : isLoading ? "loading" : "unbound"}</output>
    <EmailTaskActivity companyId={companyId} issueId={issueId} />
  </>;
}

describe("task-only connector queries", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  async function render(issueId: string) {
    flushSync(() => root.render(
      <QueryClientProvider client={client}>
        <ConnectorQueries issueId={issueId} />
      </QueryClientProvider>,
    ));
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    flushSync(() => {});
  }

  beforeEach(() => {
    vi.resetAllMocks();
    api.getIssueBinding.mockResolvedValue({ endpointId: "test-endpoint" });
    api.thread.mockResolvedValue(null);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });

  it.each([chatId, ""])("does not request task connectors for %s", async (id) => {
    await render(id);
    expect(api.getIssueBinding).not.toHaveBeenCalled();
    expect(api.thread).not.toHaveBeenCalled();
    expect(container.textContent).toBe("unbound");
  });

  it("resumes task queries when navigating from an agent chat to a task", async () => {
    await render(taskId);
    expect(api.getIssueBinding).toHaveBeenCalledWith(taskId);
    expect(api.thread).toHaveBeenCalledWith(companyId, taskId);
    expect(container.textContent).toBe("bound");

    await render(chatId);
    expect(api.getIssueBinding).toHaveBeenCalledTimes(1);
    expect(api.thread).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("unbound");

    const nextTaskId = "33333333-3333-4333-8333-333333333333";
    await render(nextTaskId);
    expect(api.getIssueBinding).toHaveBeenLastCalledWith(nextTaskId);
    expect(api.thread).toHaveBeenLastCalledWith(companyId, nextTaskId);
    expect(container.textContent).toBe("bound");
  });

  it("does not display cached task connector data for an agent chat", async () => {
    client.setQueryData(["issue-chat-binding", companyId, chatId], { endpointId: "stale-endpoint" });
    client.setQueryData(["email-thread", companyId, chatId], {
      messages: [],
      publications: [{ id: "stale-publication", outcome: "failed", error: "Stale task delivery" }],
    });
    await render(chatId);
    expect(container.textContent).toBe("unbound");
    expect(api.getIssueBinding).not.toHaveBeenCalled();
    expect(api.thread).not.toHaveBeenCalled();
  });
});
