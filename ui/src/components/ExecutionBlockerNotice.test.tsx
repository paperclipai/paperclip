// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

const api = vi.hoisted(() => ({ runsForIssue: vi.fn(), retryFailedRun: vi.fn() }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: api.runsForIssue } }));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: api.retryFailedRun } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
afterEach(async () => {
  await act(async () => { root?.unmount(); await i18n.changeLanguage("en"); });
  container?.remove();
  client?.clear();
  vi.clearAllMocks();
});

describe("ExecutionBlockerNotice localization", () => {
  it("keeps one pending retry and its raw execution target across EN, RU, and EN", async () => {
    let finishRetry!: () => void;
    api.retryFailedRun.mockReturnValue(new Promise<void>(resolve => { finishRetry = resolve; }));
    api.runsForIssue.mockResolvedValue([{ runId: "run-raw", agentId: "agent-raw", status: "failed" }]);
    const onRetried = vi.fn();
    const blocker = { runId: "run-raw", agentId: "agent-raw", nextAction: "Provider says: inspect /raw/path" } as ExecutionBlocker;
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(<QueryClientProvider client={client}><MemoryRouter><ExecutionBlockerNotice companyId="company-raw" issueId="issue-raw" blocker={blocker} onRetried={onRetried} /></MemoryRouter></QueryClientProvider>);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("Work cannot start. Provider says: inspect /raw/path");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
    await act(async () => { container.querySelector("button")!.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector("button")?.textContent).toBe("Retrying…");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector("button")?.textContent).toBe("Повторная попытка…");
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.textContent).toContain("Provider says: inspect /raw/path");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/agents/agent-raw/runs/run-raw");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.querySelector("button")?.textContent).toBe("Retrying…");
    expect(api.retryFailedRun).toHaveBeenCalledExactlyOnceWith("agent-raw", "run-raw", "company-raw");
    await act(async () => { finishRetry(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(onRetried).toHaveBeenCalledOnce();
  });
});
