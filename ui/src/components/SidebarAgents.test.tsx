// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { SidebarAgents } from "./SidebarAgents";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents") {
      return { data: [makeAgent("agent-1", "CEO"), makeAgent("agent-2", "Engineer", "agent-1")] };
    }
    if (queryKey[0] === "auth") {
      return { data: { user: { id: "user-1" } } };
    }
    if (queryKey[0] === "live-runs") {
      return { data: [] };
    }
    return { data: undefined };
  }),
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, style, onClick }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} className={className} style={style} onClick={onClick}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/agents/ceo" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewAgent: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../hooks/useAgentOrder", () => ({
  useAgentOrder: ({ agents }: { agents: Agent[] }) => ({ orderedAgents: agents }),
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: ({ className }: { className?: string }) => <span className={className} data-agent-icon />,
}));

vi.mock("./BudgetSidebarMarker", () => ({
  BudgetSidebarMarker: ({ title }: { title: string }) => <span title={title} />,
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <button type="button" className={className}>
      {children}
    </button>
  ),
}));

function makeAgent(id: string, name: string, reportsTo: string | null = null): Agent {
  return {
    id,
    companyId: "company-1",
    name,
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    urlKey: name.toLowerCase(),
  };
}

describe("SidebarAgents", () => {
  it("renders expand controls outside the navigation link", () => {
    const html = renderToStaticMarkup(<SidebarAgents />);

    expect(html).toContain('aria-label="Expand CEO"');
    expect(html).toContain('href="/agents/ceo"');
    expect(html).toMatch(/<button[^>]*aria-label="Expand CEO"[\s\S]*<\/button><a href="\/agents\/ceo"/);
    expect(html).not.toMatch(/<a href="\/agents\/ceo"[\s\S]*<button[^>]*aria-label="Expand CEO"/);
    expect(html).toMatch(/<button[^>]*aria-label="Expand CEO"[^>]*class="[^"]*cursor-pointer[^"]*"/);
  });
});
