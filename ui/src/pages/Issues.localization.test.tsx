// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { Issues } from "./Issues";

const mocks = vi.hoisted(() => ({ streamlined: false, read: vi.fn(), update: vi.fn(), breadcrumbs: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: { listCompact: mocks.read, update: mocks.update } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: mocks.read } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: mocks.read } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mocks.read } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: null }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: mocks.streamlined }) }));
vi.mock("@/hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }), usePublishSharedQueryData: () => {} }));
vi.mock("../components/IssuesList", () => ({ IssuesList: () => <div data-unexpected-issues-list /> }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: "/issues", search: "?q=RawSearch", hash: "#raw" }), useSearchParams: () => [new URLSearchParams("q=RawSearch")] }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en"); });

describe("Issues no-company localization", () => {
  it.each([false, true])("switches the empty-state message with streamlined UI %s without issuing queries or mutations", async (streamlined) => {
    mocks.streamlined = streamlined;
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => { await i18n.changeLanguage("en"); root.render(<QueryClientProvider client={client}><Issues /></QueryClientProvider>); });
      const queryKeys = client.getQueryCache().getAll().map((query) => query.queryKey);
      for (const locale of ["en", "ru", "en"] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        const expected = streamlined
          ? (locale === "en" ? "Select an organization to view tasks." : "Выберите организацию, чтобы просмотреть задачи.")
          : (locale === "en" ? "Select a company to view tasks." : "Выберите организацию, чтобы просмотреть задачи.");
        expect(host.textContent).toBe(expected);
        expect(host.querySelector("[data-unexpected-issues-list]")).toBeNull();
        expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual(queryKeys);
        expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
      }
    } finally { await act(async () => root.unmount()); host.remove(); client.clear(); }
  });
});
