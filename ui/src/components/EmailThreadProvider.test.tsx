// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailThreadProvider } from "./EmailMessageCard";

const api = vi.hoisted(() => ({ thread: vi.fn() }));
vi.mock("@/api/email", () => ({ emailApi: api }));
vi.mock("@/api/issues", () => ({ issuesApi: {} }));
vi.mock("@/hooks/useChatConnectorsEnabled", () => ({
  useChatConnectorsEnabled: () => ({ enabled: true, loaded: true }),
}));

const companyId = "test-company";
const taskId = "22222222-2222-4222-8222-222222222222";

describe("EmailThreadProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  async function render(issueId: string) {
    flushSync(() => root.render(
      <QueryClientProvider client={client}>
        <EmailThreadProvider companyId={companyId} issueId={issueId}>
          <span>child</span>
        </EmailThreadProvider>
      </QueryClientProvider>,
    ));
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  beforeEach(() => {
    vi.resetAllMocks();
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

  it.each([`chat:${taskId}`, ""])("does not request the email thread for %j", async (id) => {
    await render(id);
    expect(api.thread).not.toHaveBeenCalled();
    expect(container.textContent).toBe("child");
  });

  it("requests the email thread for a real task", async () => {
    await render(taskId);
    expect(api.thread).toHaveBeenCalledWith(companyId, taskId);
  });
});
