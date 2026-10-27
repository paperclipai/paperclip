// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionWorkspaceCompanyGate,
  UnprefixedExecutionWorkspaceRedirect,
} from "./UnprefixedExecutionWorkspaceRedirect";

const mockExecutionWorkspacesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

const PAP = { id: "company-pap", name: "Paperclip", issuePrefix: "PAP", status: "active" };
const FOR = { id: "company-for", name: "Forgotten Runes", issuePrefix: "FOR", status: "active" };
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP, FOR],
    selectedCompanyId: FOR.id,
    selectedCompany: FOR,
    loading: false,
  }),
}));

vi.mock("../pages/NotFound", () => ({
  NotFoundPage: () => <div>NOT_FOUND</div>,
}));

function Destination() {
  const location = useLocation();
  return <div>{`DESTINATION@${location.pathname}${location.search}${location.hash}`}</div>;
}

describe("UnprefixedExecutionWorkspaceRedirect", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(path: string) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedExecutionWorkspaceRedirect />} />
              <Route path=":companyPrefix/execution-workspaces/:workspaceId/issues" element={<Destination />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  function renderGate(path: string) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path=":companyPrefix" element={<ExecutionWorkspaceCompanyGate />}>
                <Route path="execution-workspaces/:workspaceId/issues" element={<Destination />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  it("uses the workspace owner instead of the selected company after login", async () => {
    mockExecutionWorkspacesApi.get.mockResolvedValue({ id: "workspace-1", companyId: PAP.id });
    render("/execution-workspaces/workspace-1/issues?tab=open#latest");

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "DESTINATION@/PAP/execution-workspaces/workspace-1/issues?tab=open#latest",
      );
    });
    expect(container.textContent).not.toContain("/FOR/execution-workspaces");
  });

  it("shows not found when the workspace cannot be resolved", async () => {
    mockExecutionWorkspacesApi.get.mockRejectedValue(new Error("Execution workspace not found"));
    render("/execution-workspaces/missing/issues");

    await vi.waitFor(() => expect(container.textContent).toContain("NOT_FOUND"));
    expect(container.textContent).not.toContain("DESTINATION@");
  });

  it("rejects a prefixed route for a different company's workspace", async () => {
    mockExecutionWorkspacesApi.get.mockResolvedValue({ id: "workspace-1", companyId: PAP.id });
    renderGate("/FOR/execution-workspaces/workspace-1/issues");

    await vi.waitFor(() => expect(container.textContent).toContain("NOT_FOUND"));
    expect(container.textContent).not.toContain("DESTINATION@");
  });
});
