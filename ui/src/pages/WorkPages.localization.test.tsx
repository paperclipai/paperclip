// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { Goals } from "./Goals";
import { MyIssues } from "./MyIssues";

const state = vi.hoisted(() => ({ companyId: null as string | null, breadcrumbs: vi.fn(), openGoal: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewGoal: state.openGoal }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.breadcrumbs }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn(async () => []) } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: vi.fn(async () => []) } }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  state.companyId = null;
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
});

function mount(page: "goals" | "tasks") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  flushSync(() => root!.render(<QueryClientProvider client={client}>{page === "goals" ? <Goals /> : <MyIssues />}</QueryClientProvider>));
}

async function switchLanguage(locale: "en" | "zh-CN") {
  await i18n.changeLanguage(locale);
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("work page localization", () => {
  it("localizes a mounted task page in both directions", async () => {
    await i18n.changeLanguage("zh-CN");
    mount("tasks");
    expect(container!.textContent).toContain("选择一个组织以查看你的任务。");
    expect(state.breadcrumbs).toHaveBeenLastCalledWith([{ label: "我的任务" }]);
    await switchLanguage("en");
    expect(container!.textContent).toContain("Select an organization to view your tasks.");
    expect(state.breadcrumbs).toHaveBeenLastCalledWith([{ label: "My Tasks" }]);
  });
  it("updates a mounted goals page and its breadcrumb without remounting", async () => {
    await i18n.changeLanguage("en");
    mount("goals");
    expect(container!.textContent).toContain("Select an organization to view goals.");
    const originalRoot = container!.firstChild;
    await switchLanguage("zh-CN");
    expect(container!.textContent).toContain("选择一个组织以查看目标。");
    expect(state.breadcrumbs).toHaveBeenLastCalledWith([{ label: "目标" }]);
    expect(container!.firstChild).toBe(originalRoot);
    await switchLanguage("en");
    expect(container!.textContent).toContain("Select an organization to view goals.");
    expect(state.breadcrumbs).toHaveBeenLastCalledWith([{ label: "Goals" }]);
  });
});
