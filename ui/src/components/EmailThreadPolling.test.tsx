// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailThreadProvider } from "./EmailMessageCard";
import { EmailTaskActivity } from "./EmailTaskActivity";

const api = vi.hoisted(() => ({ thread: vi.fn() }));
vi.mock("@/api/email", () => ({ emailApi: { thread: api.thread } }));

const emailThread = { issueId: "task-1", messages: [], publications: [] };

describe("task email polling", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    api.thread.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function render(issueId = "task-1") {
    await act(async () => {
      root.render(<QueryClientProvider client={client}>
        <EmailThreadProvider companyId="company-1" issueId={issueId}>
          <EmailTaskActivity companyId="company-1" issueId={issueId} />
        </EmailThreadProvider>
      </QueryClientProvider>);
    });
    await advance(1);
  }
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  it("stops recurring requests when both task observers find no email thread", async () => {
    api.thread.mockResolvedValue(null);
    await render();
    expect(api.thread).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(api.thread).toHaveBeenCalledTimes(1);
  });
  it("continues refreshing an email task", async () => {
    api.thread.mockResolvedValue(emailThread);
    await render();
    await advance(6_100);
    expect(api.thread.mock.calls.length).toBeGreaterThan(1);
  });
  it("can discover a thread after invalidation and resume updates", async () => {
    api.thread.mockResolvedValueOnce(null).mockResolvedValue(emailThread);
    await render();
    await act(async () => { await client.invalidateQueries({ queryKey: ["email-thread", "company-1", "task-1"] }); });
    await advance(1);
    expect(api.thread).toHaveBeenCalledTimes(2);
    await advance(3_100);
    expect(api.thread.mock.calls.length).toBeGreaterThan(2);
  });
  it("does not request email threads for chat conversations", async () => {
    await render("chat:agent-1");
    await advance(6_100);
    expect(api.thread).not.toHaveBeenCalled();
  });
});
