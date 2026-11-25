// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CoordinatorTasks } from "./CoordinatorTasks";

const scope = vi.hoisted(() => ({ companyId: "company-a", userId: "user-a" }));
const noop = vi.hoisted(() => vi.fn());

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: scope.companyId }),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: noop }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: noop }),
}));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ userId: scope.userId, loaded: true }),
}));

it("remembers the layout after reloading and keeps it scoped to the viewer and organization", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (navigation: number) => act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter key={navigation} initialEntries={["/issues?view=all"]}>
          <TooltipProvider>
            <CoordinatorTasks />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const pressed = (label: string) => button(label).getAttribute("aria-pressed");

  try {
    await render(0);
    expect(pressed("List view")).toBe("true");
    await act(async () => button("Board view").click());
    expect(pressed("Board view")).toBe("true");
    await render(1);
    expect(pressed("Board view")).toBe("true");

    scope.companyId = "company-b";
    await render(1);
    expect(pressed("List view")).toBe("true");
    scope.companyId = "company-a";
    scope.userId = "user-b";
    await render(1);
    expect(pressed("List view")).toBe("true");
    scope.userId = "user-a";
    await render(1);
    expect(pressed("Board view")).toBe("true");

    await act(async () => button("List view").click());
    await render(2);
    expect(pressed("List view")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
