// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { CaseSummary } from "@/api/cases";
import { Cases } from "./Cases";

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" as string | null }));
const casesApi = vi.hoisted(() => ({ list: vi.fn(), listTypes: vi.fn(), get: vi.fn(), patch: vi.fn() }));
const projectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const setBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/api/cases", async importOriginal => ({
  ...(await importOriginal<typeof import("@/api/cases")>()), casesApi,
}));
vi.mock("@/api/projects", () => ({ projectsApi }));
vi.mock("@/lib/router", async () => ({
  ...(await import("react-router-dom")),
  useCaseHref: () => (...segments: string[]) => `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createCase(overrides: Partial<CaseSummary> = {}): CaseSummary {
  return {
    id: "case-1", companyId: "company-1", projectId: null, caseNumber: 1,
    identifier: "PAP-C1", caseType: "Bug", key: null, title: "Webhook delivery",
    summary: "Preserve the original event receipt", status: "in_progress", fields: {},
    parentCaseId: null, createdByAgentId: null, createdByUserId: null, completedAt: null,
    createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T10:00:00Z",
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output data-testid="location">{location.pathname}{location.search}</output>
    <button onClick={() => navigate(-1)}>History back</button>
    <button onClick={() => navigate(1)}>History forward</button>
  </>;
}
function DetailProbe() {
  const location = useLocation();
  return <Link to={`/PAP/cases${location.search}`}>Back to cases</Link>;
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { assertion(); return; } catch (error) { lastError = error; await settle(); }
  }
  throw lastError;
}
async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

let container: HTMLDivElement;
let root: Root;
async function renderPage(path = "/PAP/cases") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/PAP/cases" element={<Cases />} />
        <Route path="/PAP/cases/:caseIdentifier" element={<DetailProbe />} />
      </Routes>
    </MemoryRouter></QueryClientProvider>);
  });
}
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(item => item.textContent === label);
  expect(element, `Missing button ${label}`).toBeTruthy();
  return element!;
}
function labelledButton(label: string) {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(element, `Missing ${label} control`).toBeTruthy();
  return element!;
}
async function openColumns() {
  await act(async () => {
    labelledButton("Columns").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
}
async function escape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("Read-only cases list", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    companyState.selectedCompanyId = "company-1";
    casesApi.list.mockReset().mockResolvedValue([createCase()]);
    casesApi.listTypes.mockReset().mockResolvedValue(["Bug", "Research"]);
    casesApi.get.mockReset();
    casesApi.patch.mockReset();
    projectsApi.list.mockReset().mockResolvedValue([{ id: "project-1", name: "Paperclip" }]);
    setBreadcrumbs.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses batched primary-work data and static statuses without case-edit controls", async () => {
    casesApi.list.mockResolvedValue([
      createCase({ projectId: "project-1", workIssueId: "task-1", phase: "Implementation",
        workIssue: { id: "task-1", identifier: "PAP-812", title: "Fix webhook intake", status: "in_progress",
          statusVersion: 2, assigneeAgentId: "agent-codex", assigneeAgentName: "Codex Coder" } }),
      createCase({ id: "case-2", identifier: "PAP-C2", title: "Published guide", status: "done" }),
    ]);
    await renderPage();
    await waitFor(() => expect(container.textContent).toContain("Codex Coder"));
    expect(container.textContent).toContain("Implementation");
    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("Published guide");
    expect(container.textContent).toContain("Done");
    expect(container.querySelector('[aria-label="Change case status"]')).toBeNull();
    expect(container.querySelector('button[title*="case list"]')).toBeNull();
    const controls = container.querySelector('[role="toolbar"][aria-label="Case controls"]')!;
    expect([...controls.querySelectorAll('button[aria-label]')].map(element => element.getAttribute("aria-label")))
      .toEqual(["Columns", "Filter cases", "Sort", "Group"]);
    expect(container.textContent).not.toMatch(/Create case|New case|Kanban|Tree view/);
    expect(container.querySelector('[aria-label*="Kanban"]')).toBeNull();
    expect(casesApi.get).not.toHaveBeenCalled();
    expect(casesApi.patch).not.toHaveBeenCalled();
    expect(casesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ limit: 51, offset: 0, status: undefined }));
  });

  it("sends URL filters before paging, including No project, and retains them through detail and back", async () => {
    const query = "?q=webhook&status=in_review&type=Bug&project=none&page=3";
    await renderPage(`/PAP/cases${query}`);
    await waitFor(() => expect(container.querySelector('a[href^="/PAP/cases/PAP-C1"]')).not.toBeNull());
    expect(casesApi.list).toHaveBeenLastCalledWith("company-1", {
      q: "webhook", status: "in_review", type: "Bug", projectId: undefined,
      includeNoProject: true, limit: 51, offset: 100,
    });
    const row = container.querySelector('a[href^="/PAP/cases/PAP-C1"]')!;
    expect(row.getAttribute("href")).toBe(`/PAP/cases/PAP-C1${query}`);
    await click(row);
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(`/PAP/cases/PAP-C1${query}`);
    await click(container.querySelector('a')!);
    await waitFor(() => expect(container.querySelector('input[aria-label="Search cases"]')).not.toBeNull());
    expect((container.querySelector('input[aria-label="Search cases"]') as HTMLInputElement).value).toBe("webhook");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(`/PAP/cases${query}`);
  });

  it("updates search on the server and resets pagination without losing the other filters", async () => {
    await renderPage("/PAP/cases?status=in_progress&project=project-1&page=2");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search cases"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "all");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      q: "all", status: "in_progress", projectId: "project-1", offset: 0,
    })));
    expect(container.querySelector('[data-testid="location"]')?.textContent).not.toContain("page=");
    expect(casesApi.listTypes).toHaveBeenCalledWith("company-1");
  });

  it("preserves a newly selected type when search changes before its navigation settles", async () => {
    await renderPage();
    await waitFor(() => expect(casesApi.listTypes).toHaveBeenCalled());
    await click(labelledButton("Filter cases"));
    await click(document.body.querySelector('[aria-label="Filter by type"]')!);
    const option = [...document.body.querySelectorAll('[role="option"]')]
      .find(element => element.textContent === "Bug")!;
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search cases"]')!;
    // Both user changes can precede React Router's next render. URL updates
    // must compose rather than the later search replacing the selected type.
    await act(async () => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "webhook");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      q: "webhook", type: "Bug", offset: 0,
    })));
    expect(new URLSearchParams(container.querySelector('[data-testid="location"]')!.textContent!.split("?")[1]).get("type"))
      .toBe("Bug");
  });

  it("uses restored URL filters after back and forward navigation", async () => {
    casesApi.list.mockResolvedValue(Array.from({ length: 51 }, (_, index) => createCase({ id: `case-${index}` })));
    await renderPage("/PAP/cases?type=Bug");
    await waitFor(() => expect(button("Next").disabled).toBe(false));
    await click(button("Next"));
    await click(labelledButton("Filter cases (1 active)"));
    await click(document.body.querySelector('[aria-label="Filter by type"]')!);
    await click([...document.body.querySelectorAll('[role="option"]')].find(element => element.textContent === "Research")!);
    await escape();
    await click(button("History back"));
    for (const [type, query] of [["Bug", "restored back"], ["Research", "restored forward"]]) {
      await waitFor(() => expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ type })));
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Search cases"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await waitFor(() => expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ type, q: query })));
      if (type === "Bug") await click(button("History forward"));
    }
  });

  it("keeps cold URL filter selections while filter choices load", async () => {
    let resolveTypes: (types: string[]) => void = () => {};
    let resolveProjects: (projects: Array<{ id: string; name: string }>) => void = () => {};
    casesApi.listTypes.mockReturnValueOnce(new Promise(resolve => { resolveTypes = resolve; }));
    projectsApi.list.mockReturnValueOnce(new Promise(resolve => { resolveProjects = resolve; }));
    const query = "?q=Pacific&type=receipt&status=in_review&project=project-1";
    await renderPage(`/PAP/cases${query}`);
    await click(labelledButton("Filter cases (3 active)"));
    expect(document.body.querySelector('[aria-label="Filter by type"]')?.textContent).toBe("receipt");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(`/PAP/cases${query}`);
    await act(async () => {
      resolveTypes(["receipt", "research"]);
      resolveProjects([{ id: "project-1", name: "Receipt project" }]);
    });
    await waitFor(() => expect(document.body.querySelector('[aria-label="Filter by project"]')?.textContent).toBe("Receipt project"));
    expect(document.body.querySelector('[aria-label="Filter by type"]')?.textContent).toBe("receipt");
    expect(document.body.querySelector('[aria-label="Filter by status"]')?.textContent).toBe("In review");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(`/PAP/cases${query}`);
    expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ q: "Pacific", type: "receipt", status: "in_review", projectId: "project-1" }));
  });

  it("changes visible columns without editing case data and preserves the view through navigation", async () => {
    await renderPage();
    await waitFor(() => expect(container.querySelector('a[href^="/PAP/cases/PAP-C1"]')).not.toBeNull());
    await openColumns();
    const type = [...document.body.querySelectorAll('[role="menuitemcheckbox"]')].find(element => element.textContent === "Type")!;
    expect(type.getAttribute("aria-checked")).toBe("true");
    await click(type);
    expect(type.getAttribute("aria-checked")).toBe("false");
    await escape();
    const row = container.querySelector('a[href^="/PAP/cases/PAP-C1"]')!;
    expect(row.textContent).not.toContain("Bug");
    expect(row.textContent).toContain("Webhook delivery");
    expect(row.getAttribute("href")).toContain("columns=identifier%2Cproject%2Cphase%2Cassignee%2Cstatus");
    await click(row);
    await click(container.querySelector('a')!);
    await waitFor(() => expect(container.querySelector('a[href^="/PAP/cases/PAP-C1"]')?.textContent).not.toContain("Bug"));
    expect(casesApi.patch).not.toHaveBeenCalled();
  });

  it("sends sort and grouping before pagination and renders group headers", async () => {
    casesApi.list.mockResolvedValue([
      createCase(),
      createCase({ id: "case-2", identifier: "PAP-C2", title: "Research receipts", caseType: "Research" }),
    ]);
    await renderPage("/PAP/cases?page=2");
    await click(labelledButton("Sort"));
    const title = [...document.body.querySelectorAll('[aria-label="Sort cases"] button')]
      .find(element => element.textContent === "Title")!;
    await click(title);
    await waitFor(() => expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      sortField: "title", sortDir: "asc", offset: 0,
    })));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/PAP/cases?sort=title&dir=asc");
    await escape();
    await waitFor(() => expect(document.activeElement).toBe(labelledButton("Sort")));
    await click(labelledButton("Group"));
    const type = [...document.body.querySelectorAll('[aria-label="Group cases"] button')]
      .find(element => element.textContent === "Type")!;
    await click(type);
    await waitFor(() => expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      sortField: "title", sortDir: "asc", groupBy: "type", offset: 0,
    })));
    await escape();
    const list = container.querySelector('[aria-label="Case list"]')!;
    expect([...list.children].map(group => group.firstElementChild?.textContent)).toEqual(["Bug", "Research"]);
    const firstRow = list.querySelector('a')!;
    expect(firstRow.getAttribute("href")).toContain("sort=title&dir=asc&group=type");
    expect(casesApi.patch).not.toHaveBeenCalled();
  });

  it("pages server results without hiding records or filtering the first page locally", async () => {
    const records = Array.from({ length: 51 }, (_, index) => createCase({
      id: `case-${index + 1}`, identifier: `PAP-C${index + 1}`, title: `Record ${index + 1}`,
    }));
    casesApi.list.mockImplementation((_companyId, filters) => Promise.resolve(filters.offset ? [records[50]] : records));
    await renderPage("/PAP/cases?type=Bug");
    await waitFor(() => expect(container.textContent).toContain("50+ cases"));
    expect(container.querySelector('a[href*="PAP-C51"]')).toBeNull();
    await click(button("Next"));
    await waitFor(() => expect(container.querySelector('a[href*="PAP-C51"]')).not.toBeNull());
    expect(casesApi.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ type: "Bug", offset: 50, limit: 51 }));
    expect(button("Next").disabled).toBe(true);
    expect(button("Previous").disabled).toBe(false);
    await click(button("Previous"));
    await waitFor(() => expect(container.querySelector('a[href*="PAP-C1?"]')).not.toBeNull());
  });

  it("shows loading, a recoverable error, and a quiet empty state without creation controls", async () => {
    let rejectList: (error: Error) => void = () => {};
    casesApi.list.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectList = reject; }));
    await renderPage();
    expect(container.textContent).toContain("Loading cases…");
    await act(async () => rejectList(new Error("Unavailable")));
    await waitFor(() => expect(container.textContent).toContain("Cases couldn’t be loaded."));
    casesApi.list.mockResolvedValue([]);
    await click(button("Try again"));
    await waitFor(() => expect(container.textContent).toContain("No cases yet"));
    expect(container.textContent).not.toMatch(/Create case|New case|references\/cases/);
  });

  it("does not request company data before a company is selected", async () => {
    companyState.selectedCompanyId = null;
    await renderPage();
    expect(container.textContent).toContain("Select a company to view cases.");
    expect(casesApi.list).not.toHaveBeenCalled();
    expect(casesApi.listTypes).not.toHaveBeenCalled();
    expect(projectsApi.list).not.toHaveBeenCalled();
  });
});
