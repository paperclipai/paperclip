// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AgentContextualSidebar } from "./AgentContextualSidebar";

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

describe("AgentContextualSidebar", () => {
  it("renders local definition/runtime/governance links and scoped Audit links", () => {
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
    expect(markup).toContain('href="/agents/codexcoder/permissions"');
    expect(markup).toContain('href="/agents/codexcoder/api-keys"');
    expect(markup).toContain('href="/activity?mode=agents&amp;agentId=agent-1"');
    expect(markup).toContain('href="/activity/runs?agentId=agent-1"');
    expect(markup).toContain("Harness / Runtime");
    expect(markup).toContain("Permissions / Trust");
  });
});
