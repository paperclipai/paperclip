// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CoordinatorTasks } from "./CoordinatorTasks";

const noop = vi.hoisted(() => vi.fn());

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-a" }),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: noop }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: noop }),
}));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ userId: "user-a", loaded: true }),
}));
vi.mock("@/hooks/useWarmTaskDetailCode", () => ({
  useWarmTaskDetailCode: noop,
}));

it("shows running and waiting tasks in both layouts and clears their markers when the runs end", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const tasks = ["running", "idle", "queued"].map((id, index) => ({
    id, identifier: `TASK-${index + 1}`, title: `${id} task`,
    companyId: "company-a", status: "todo", priority: "medium", parentId: id === "queued" ? "idle" : null,
    createdAt: "2026-11-24T10:00:00Z", updatedAt: "2026-11-24T10:00:00Z",
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: string) =>
    Response.json(input.startsWith("/api/companies/company-a/issues?") ? tasks : [])));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const runsKey = queryKeys.liveRuns("company-a");
  client.setQueryData(runsKey, [
    { id: "run-a", issueId: "running", status: "running" },
    { id: "run-b", issueId: "queued", status: "queued", startedAt: null },
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const visibleTask = (id: string) => [...container.querySelectorAll(`[data-issue-row-details="${id}"]`)]
    .find(row => !row.closest("[hidden]"));
  const liveMarker = (id: string) => visibleTask(id)?.querySelector(".animate-pulse");
  const waitingMarker = () => visibleTask("queued")?.querySelector('[data-testid="agent-queue-wait-chip"]');
  const selectLayout = (label: string) => act(async () =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());

  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/issues?view=all"]}>
          <TooltipProvider>
            <CoordinatorTasks />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await act(async () => vi.waitFor(() => expect(visibleTask("idle")).toBeDefined()));
    expect(liveMarker("running")).not.toBeNull();
    expect(liveMarker("idle")).toBeNull();
    expect(liveMarker("queued")).toBeNull();
    expect(waitingMarker()).not.toBeNull();

    await selectLayout("Board view");
    expect(visibleTask("running")).toBeDefined();
    expect(liveMarker("running")).not.toBeNull();
    expect(liveMarker("idle")).toBeNull();
    expect(liveMarker("queued")).toBeNull();
    expect(waitingMarker()).not.toBeNull();
    expect(visibleTask("idle")?.textContent).not.toContain("live below");

    await act(async () => {
      client.setQueryData(runsKey, []);
      await vi.waitFor(() => expect(liveMarker("running")).toBeNull());
    });
    expect(waitingMarker()).toBeNull();
    await selectLayout("List view");
    expect(visibleTask("running")).toBeDefined();
    expect(liveMarker("running")).toBeNull();
    expect(waitingMarker()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
