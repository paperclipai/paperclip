import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { Dashboard } from "./Dashboard";

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", companies: [] }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/dashboard" }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("../hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({}), usePublishSharedQueryData: () => {} }));
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("../components/SmokeLabDashboardCard", () => ({ SmokeLabDashboardCard: () => null }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));

function renderDashboard(importedAgentCount = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.agents.list("company-1"), Array.from({ length: importedAgentCount }, (_, index) => ({ id: `agent-${index}`, name: `UserAgent ${index}`, status: "paused", pauseReason: "import" })));
  client.setQueryData(queryKeys.issues.list("company-1"), []);
  client.setQueryData(queryKeys.dashboard("company-1"), {
    agents: { active: 1, running: 2, paused: 3, error: 4 },
    tasks: { inProgress: 2, open: 3, blocked: 4 },
    budgets: { activeIncidents: 2, pausedAgents: 3, pausedProjects: 4, pendingApprovals: 5 },
    costs: { monthSpendCents: 100, monthBudgetCents: 1000, monthUtilizationPercent: 10 },
    pendingApprovals: 1,
    runActivity: [],
  });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Dashboard)));
  } finally { client.clear(); }
}

describe("Dashboard localization", () => {
  it("renders Chinese metric sentences, import plurals and chart titles with English fallback", async () => {
    try {
      await i18n.changeLanguage("zh-CN");
      const chinese = renderDashboard();
      expect(chinese).toContain("1 个导入的智能体已暂停，不会运行。");
      expect(chinese).toContain("2 个正在运行，3 个已暂停，4 个出错");
      expect(chinese).toContain("3 个待处理，4 个受阻");
      expect(chinese).toContain("2 起未解决的预算事件");
      expect(chinese).toContain("运行活动");
      expect(chinese).toContain("最近 14 天");
      expect(chinese).toContain("暂无任务。");
      await i18n.changeLanguage("en");
      const english = renderDashboard();
      expect(english).toContain("1 imported agent is paused and will not run.");
      expect(english).toContain("2 running, 3 paused, 4 errors");
      expect(english).toContain("Run Activity");
      expect(renderDashboard(2)).toContain("2 imported agents are paused and will not run.");
      expect(english).toContain("5 budget overrides awaiting board review");
      await i18n.changeLanguage("fr");
      expect(renderDashboard()).toContain("Run Activity");
    } finally { await i18n.changeLanguage("en"); }
  });
});
