// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { MyIssues } from "./MyIssues";

const state = vi.hoisted(() => ({ companyId: null as string | null, streamlined: true, setBreadcrumbs: vi.fn(), list: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.setBreadcrumbs }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: state.streamlined }) }));
vi.mock("../api/issues", () => ({ issuesApi: { list: state.list } }));
vi.mock("../components/StatusIcon", () => ({ StatusIcon: () => null }));
vi.mock("../components/EntityRow", () => ({ EntityRow: ({ title, to }: { title: string; to: string }) => <a href={to}>{title}</a> }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MyIssues localization", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    state.companyId = null;
    state.streamlined = true;
    state.setBreadcrumbs.mockReset();
    state.list.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    await i18n.changeLanguage("en");
  });
  async function render() { await act(async () => root.render(<QueryClientProvider client={client}><MyIssues /></QueryClientProvider>)); }

  it.each([true, false])("preserves organization/company wording and updates breadcrumbs (streamlined=%s)", async (streamlined) => {
    state.streamlined = streamlined;
    await render();
    expect(container.textContent).toContain(`Select a${streamlined ? "n organization" : " company"} to view your tasks.`);
    expect(state.setBreadcrumbs).toHaveBeenLastCalledWith([{ label: "My Tasks" }]);
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain(`Выберите ${streamlined ? "организацию" : "компанию"}, чтобы просмотреть свои задачи.`);
    expect(state.setBreadcrumbs).toHaveBeenLastCalledWith([{ label: "Мои задачи" }]);
    expect(state.list).not.toHaveBeenCalled();
  });

  it("localizes the empty state without refetching or altering stored task data", async () => {
    state.companyId = "company-raw";
    const issues = [{ id: "done-id", status: "done", assigneeAgentId: null }];
    const key = queryKeys.issues.list(state.companyId);
    client.setQueryData(key, issues);
    await render();
    expect(container.textContent).toContain("No tasks assigned to you.");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Вам не назначено ни одной задачи.");
    expect(client.getQueryData(key)).toBe(issues);
    expect(state.list).not.toHaveBeenCalled();
  });

  it("keeps user task titles, identifiers and filtering unchanged", async () => {
    state.companyId = "company-raw";
    const issues = [
      { id: "open-id", identifier: "RAW-12", title: "Keep my English title", status: "todo", assigneeAgentId: null, createdAt: "2026-08-31T12:00:00Z" },
      { id: "assigned-id", title: "Agent task", status: "todo", assigneeAgentId: "agent-raw" },
    ];
    client.setQueryData(queryKeys.issues.list(state.companyId), issues);
    await render();
    const link = container.querySelector("a")!;
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(link.textContent).toBe("Keep my English title");
    expect(link.getAttribute("href")).toBe("/issues/RAW-12");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});
