// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyProvider, useCompany } from "./CompanyContext";

const companiesApiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

const healthApiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

const authApiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: companiesApiMocks,
}));

vi.mock("../api/health", () => ({
  healthApi: healthApiMocks,
}));

vi.mock("../api/auth", () => ({
  authApi: authApiMocks,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { companies, loading } = useCompany();
  return (
    <div data-loading={loading ? "true" : "false"}>
      {companies.map((company) => company.issuePrefix).join(",")}
    </div>
  );
}

async function flushQueries() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("CompanyProvider", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
  });

  it("does not fetch companies before board auth resolves in authenticated mode", async () => {
    healthApiMocks.get.mockResolvedValue({ deploymentMode: "authenticated" });
    authApiMocks.getSession.mockResolvedValue(null);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    expect(authApiMocks.getSession).toHaveBeenCalledTimes(1);
    expect(companiesApiMocks.list).not.toHaveBeenCalled();
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
  });

  it("fetches companies once local trusted access is confirmed", async () => {
    healthApiMocks.get.mockResolvedValue({ deploymentMode: "local_trusted" });
    companiesApiMocks.list.mockResolvedValue([
      { id: "company-1", issuePrefix: "PAP", status: "active" },
    ]);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    expect(authApiMocks.getSession).not.toHaveBeenCalled();
    expect(companiesApiMocks.list).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("PAP");
  });
});
