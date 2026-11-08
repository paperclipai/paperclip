import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { DashboardLive } from "./DashboardLive";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", companies: [] }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock("../components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: ({ title, emptyMessage }: { title: string; emptyMessage: string }) => <section><h2>{title}</h2><p>{emptyMessage}</p></section>,
}));

describe("DashboardLive localization", () => {
  it("renders Chinese and English with complete limit interpolation and unchanged dashboard route", async () => {
    try {
      await i18n.changeLanguage("zh-CN");
      const chinese = renderToStaticMarkup(<DashboardLive />);
      expect(chinese).toContain("智能体实时运行");
      expect(chinese).toContain("最多显示 50 条");
      expect(chinese).toContain("暂无进行中或近期的智能体运行记录。");
      expect(chinese).toContain('href="/dashboard"');
      await i18n.changeLanguage("en");
      const english = renderToStaticMarkup(<DashboardLive />);
      expect(english).toContain("Live agent runs");
      expect(english).toContain("Showing up to 50");
      expect(english).not.toContain("智能体实时运行");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
