// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { ClaudeProjectTrust } from "./ClaudeProjectTrust";

vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/projects", () => ({ projectsApi: { getClaudeProjectTrust: vi.fn(), setClaudeProjectTrust: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = { id: "workspace", sourceType: "local_path", cwd: "/reviewed", repoUrl: null, repoRef: null,
  defaultRef: null, remoteProvider: null, remoteWorkspaceRef: null, updatedAt: "2026-11-09T10:00:00Z" } as unknown as ProjectWorkspace;

describe("Claude project trust consent", () => {
  it.each([
    { cwd: "/replacement", updatedAt: "2026-11-09T10:01:00Z" },
    { repoUrl: "https://example.test/replacement.git", updatedAt: "2026-11-09T10:01:00Z" },
    { updatedAt: "2026-11-09T10:01:00Z" },
  ])("clears unsaved choices after the reviewed workspace changes: %j", async (changed) => {
    const empty = { agentIds: [] as string[] };
    vi.mocked(projectsApi.getClaudeProjectTrust).mockResolvedValue(empty);
    vi.mocked(projectsApi.setClaudeProjectTrust).mockResolvedValue(empty);
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent", name: "Claude", adapterType: "claude_local" }] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const container = document.createElement("div"); const root = createRoot(container); document.body.appendChild(container);
    const render = (value: ProjectWorkspace) => root.render(<QueryClientProvider client={client}>
      <ClaudeProjectTrust companyId="company" projectId="project" workspace={value} disabled={false} onSaved={() => {}} />
    </QueryClientProvider>);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await act(async () => { render(workspace); await settle(); });
      await act(async () => { await settle(); });
      const checkbox = () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
      await act(async () => { checkbox().click(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("true");
      await act(async () => { render({ ...workspace, ...changed } as ProjectWorkspace); await settle(); });
      await act(async () => { await settle(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("false");
      const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save Claude trust")!;
      await act(async () => { save.click(); await settle(); });
      expect(vi.mocked(projectsApi.setClaudeProjectTrust).mock.calls.at(-1)?.[2]).toEqual([]);
    } finally { await act(async () => root.unmount()); container.remove(); client.clear(); vi.clearAllMocks(); }
  });
  it("waits for the new source grants instead of reusing cached grants from the old source", async () => {
    let finish!: (value: { agentIds: string[] }) => void;
    vi.mocked(projectsApi.getClaudeProjectTrust).mockResolvedValueOnce({ agentIds: ["agent"] })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent", name: "Claude", adapterType: "claude_local" }] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const container = document.createElement("div"); const root = createRoot(container); document.body.appendChild(container);
    const render = (value: ProjectWorkspace) => root.render(<QueryClientProvider client={client}>
      <ClaudeProjectTrust companyId="company" projectId="project" workspace={value} disabled={false} onSaved={() => {}} />
    </QueryClientProvider>);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await act(async () => { render(workspace); await settle(); });
      await act(async () => { await settle(); });
      const checkbox = () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
      const save = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Save Claude trust")!;
      expect(checkbox().getAttribute("aria-checked")).toBe("true");
      await act(async () => { render({ ...workspace, cwd: "/replacement" }); await settle(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("false");
      expect(save().disabled).toBe(true);
      expect(projectsApi.getClaudeProjectTrust).toHaveBeenCalledTimes(2);
      await act(async () => { finish({ agentIds: [] }); await settle(); });
      await act(async () => { await settle(); });
      expect(checkbox().getAttribute("aria-checked")).toBe("false");
      expect(save().disabled).toBe(false);
    } finally { await act(async () => root.unmount()); container.remove(); client.clear(); vi.clearAllMocks(); }
  });

});
