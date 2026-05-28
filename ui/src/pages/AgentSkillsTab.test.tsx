// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSkillsTab } from "./AgentDetail";

const mockAgentsApi = vi.hoisted(() => ({
  skills: vi.fn(),
  syncSkills: vi.fn(),
}));

const mockCompanySkillsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>{children}</a>
  ),
  Navigate: () => null,
  useBeforeUnload: () => undefined,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: mockCompanySkillsApi,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <div />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Codex Lead Engineer",
    urlKey: "codex-lead-engineer",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentSkillsTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAgentsApi.skills.mockResolvedValue({
      adapterType: "codex_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclip"],
      entries: [
        {
          key: "paperclip",
          runtimeName: "paperclip",
          desired: true,
          managed: true,
          state: "configured",
          origin: "company_managed",
        },
        {
          key: "local-debug",
          runtimeName: "local-debug",
          desired: false,
          managed: false,
          state: "external",
          origin: "user_installed",
          originLabel: "User-installed skill",
          locationLabel: "C:\\tools\\skills\\local-debug",
        },
      ],
      warnings: [],
    });
    mockCompanySkillsApi.list.mockResolvedValue([
      {
        id: "skill-paperclip",
        companyId: "company-1",
        key: "paperclip",
        slug: "paperclip",
        name: "Paperclip",
        description: "Paperclip runtime controls",
        sourceType: "catalog",
        sourceLocator: null,
        sourceRef: null,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [],
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        attachedAgentCount: 1,
        editable: true,
        editableReason: null,
        sourceLabel: "Catalog",
        sourceBadge: "catalog",
        sourcePath: null,
      },
    ]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("explains the skills attach flow and read-only unmanaged skills", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentSkillsTab agent={createAgent()} companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(container.textContent).toContain("Skill operation flow");
    expect(container.textContent).toContain("Company skills are the source list for attachable skills.");
    expect(container.textContent).toContain("Use checkboxes to attach or detach skills for this agent.");
    expect(container.textContent).toContain("Selected skills are used by this agent according to the application mode below.");
    expect(container.textContent).toContain("Attached to this agent");
    expect(container.textContent).toContain("User-installed skills, not managed by Paperclip");

    const unmanagedToggle = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((element) => element.textContent?.includes("User-installed skills"));
    expect(unmanagedToggle).toBeDefined();
    await act(async () => {
      unmanagedToggle?.click();
    });
    await flush();

    expect(container.textContent).toContain("Adapter-detected, read-only");
  });
});
