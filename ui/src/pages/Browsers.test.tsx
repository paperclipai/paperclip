// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browsers } from "./Browsers";

const mockLiveRunsForCompany = vi.hoisted(() => vi.fn());
const mockBrowserProfiles = vi.hoisted(() => vi.fn());
const mockCreateBrowserProfile = vi.hoisted(() => vi.fn());
const mockAssignBrowserProfile = vi.hoisted(() => vi.fn());
const mockDeleteBrowserProfile = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const openedStreams: string[] = [];

class MockEventSource {
  onerror: (() => void) | null = null;
  constructor(public url: string) { openedStreams.push(url); }
  addEventListener() {}
  close() {}
}

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: mockLiveRunsForCompany,
    browserProfiles: mockBrowserProfiles,
    createBrowserProfile: mockCreateBrowserProfile,
    assignBrowserProfile: mockAssignBrowserProfile,
    deleteBrowserProfile: mockDeleteBrowserProfile,
  },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Browsers", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    openedStreams.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
    mockBrowserProfiles.mockResolvedValue({
      profiles: [{ id: "default", name: "Default", sessionName: "paperclip-company-1-default", isDefault: true, createdAt: "" }],
      projects: [{ id: "project-1", name: "Storefront", profileId: "default" }],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens only the latest live stream for each issue", async () => {
    mockLiveRunsForCompany.mockResolvedValue([
      { id: "run-1", agentId: "agent-1", agentName: "Atlas", status: "running", adapterType: "codex", invocationSource: "issue", triggerDetail: null, startedAt: "2026-07-11T00:00:00Z", finishedAt: null, createdAt: "2026-07-11T00:00:00Z", issueId: "issue-1", issueIdentifier: "ELIA-10", issueTitle: "Research vendor" },
      { id: "run-2", agentId: "agent-2", agentName: "Nova", status: "running", adapterType: "codex", invocationSource: "issue", triggerDetail: null, startedAt: "2026-07-11T00:00:01Z", finishedAt: null, createdAt: "2026-07-11T00:00:01Z", issueId: "issue-2", issueIdentifier: "ELIA-11", issueTitle: "Validate checkout" },
      { id: "run-0", agentId: "agent-1", agentName: "Atlas", status: "succeeded", adapterType: "codex", invocationSource: "issue", triggerDetail: null, startedAt: "2026-07-10T23:00:00Z", finishedAt: "2026-07-10T23:05:00Z", createdAt: "2026-07-10T23:00:00Z", issueId: "issue-1", issueIdentifier: "ELIA-10", issueTitle: "Research vendor" },
    ]);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(<QueryClientProvider client={client}><Browsers /></QueryClientProvider>);
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

    expect(container.textContent).toContain("2 active · 2 recent");
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("ELIA-11");
    expect(openedStreams).toEqual(expect.arrayContaining([
      "/api/heartbeat-runs/run-1/browser-stream",
      "/api/heartbeat-runs/run-2/browser-stream",
    ]));
    expect(openedStreams).not.toContain("/api/heartbeat-runs/run-0/browser-stream");
    expect(new Set(openedStreams).size).toBe(2);

    await act(async () => root.unmount());
  });

  it("shows the default profile and project assignment in the profiles manager", async () => {
    mockLiveRunsForCompany.mockResolvedValue([]);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><Browsers /></QueryClientProvider>); });
    const profilesButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Profiles"));
    await act(async () => { profilesButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

    expect(document.body.textContent).toContain("Browser profiles");
    expect(document.body.textContent).toContain("Company default");
    expect(document.body.textContent).toContain("Storefront");

    await act(async () => root.unmount());
  });
});
