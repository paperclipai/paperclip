// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AgentContextualSidebar } from "./AgentContextualSidebar";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("./ContextualSidebarFrame", () => ({
  ContextualSidebarFrame: ({
    title,
    showHeader,
    className,
    children,
  }: {
    title: string;
    showHeader?: boolean;
    className?: string;
    children: React.ReactNode;
  }) => (
    <aside data-title={title} data-show-header={String(showHeader)} className={className}>
      {children}
    </aside>
  ),
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: ({ to, label }: { to: string; label: string }) => <a href={to}>{label}</a>,
}));

vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => ({ slots: [{ pluginKey: "test.plugin", id: "insights", displayName: "Insights" }, { pluginKey: "example.computer", id: "desktop", displayName: "Desktop", agentEnvironmentDriver: "tasks" }] }) }));

describe("AgentContextualSidebar", () => {
  it.each([false, true])("lists plugin tabs and keeps Channels and Tools out of the nav (%s)", (enabled) => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: enabled });
    const markup = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter>
      <AgentContextualSidebar agentRef="agent" agentId="agent-1" agentName="Agent" />
    </MemoryRouter></QueryClientProvider>);
    expect(markup).toContain("Insights");
    expect(markup).toContain("plugin%3Atest.plugin%3Ainsights");
    expect(markup).not.toContain('href="/agents/agent/channels"');
    expect(markup).not.toContain('href="/agents/agent/tools"');
    client.clear();
  });
  it("renders the Agent and Audit sections with audit pages inside the agent", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/agents/codexcoder/runtime"]}>
          <AgentContextualSidebar agentRef="codexcoder" agentId="agent-1" agentName="Codex Coder" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain("Codex Coder");
    expect(markup).toContain('data-show-header="false"');
    expect(markup).toContain("border-r border-border bg-background");
    expect(markup).toContain('data-slot="contextual-sidebar-nav"');
    expect(markup).toContain('href="/agents/codexcoder/overview"');
    expect(markup).toContain('href="/agents/codexcoder/advanced"');
    expect(markup).toContain('href="/agents/codexcoder/permissions"');
    expect(markup).toContain('href="/agents/codexcoder/identity"');
    expect(markup).not.toContain('href="/agents/codexcoder/api-keys"');
    expect(markup).toContain('href="/agents/codexcoder/activity"');
    expect(markup).toContain('href="/agents/codexcoder/runs"');
    expect(markup).toContain('href="/agents/codexcoder/budgets"');
    expect(markup).toContain("Secrets &amp; variables");
    expect(markup).toContain("Harness / Runtime");
    expect(markup).toContain("Permissions / Trust");
  });
});

it.each(["computer", "local"])("offers environment-specific navigation only for the configured %s agent", environmentId => {
  const client = new QueryClient();
  client.setQueryData([...queryKeys.agents.detail("agent-1"), "company-1"], { id: "agent-1", companyId: "company-1", defaultEnvironmentId: environmentId });
  client.setQueryData(queryKeys.environments.list("company-1"), [{ id: "computer", driver: "plugin", config: {}, pluginDriver: { pluginKey: "example.computer", driverKey: "tasks" } }]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter>
    <AgentContextualSidebar agentRef="agent" agentId="agent-1" agentName="Agent" />
  </MemoryRouter></QueryClientProvider>);
  expect(markup.includes("Desktop")).toBe(environmentId === "computer");
  expect(markup).toContain("Insights"); client.clear();
});
