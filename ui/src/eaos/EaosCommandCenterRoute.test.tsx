// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const companyContext: {
  companies: { id: string; name: string; issuePrefix: string; status: string }[];
  loading: boolean;
} = { companies: [], loading: false };

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: companyContext.companies,
    selectedCompany: companyContext.companies[0] ?? null,
    selectedCompanyId: companyContext.companies[0]?.id ?? null,
    loading: companyContext.loading,
  }),
}));

// The dashboard reads activity / agents / issues. Mock the telemetry hook
// to a non-loading empty state so the rendered tree is deterministic.
vi.mock("./command-center/mission-telemetry", () => ({
  useMissionTelemetry: () => ({
    companyScoped: false,
    isLoading: false,
    isError: false,
    counts: { active: 0, blocked: 0, inReview: 0, done: 0 },
    criticalAttention: 0,
    agents: { active: 0, executing: 0, total: 0 },
    running: [],
    blocked: [],
    inReview: [],
    recentlyCompleted: [],
  }),
}));

import { EaosCommandCenterRoute } from "./EaosCommandCenterRoute";

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  companyContext.companies = [];
  companyContext.loading = false;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderRoute() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos"]}>
          <Routes>
            <Route path="/eaos" element={<EaosCommandCenterRoute />} />
            <Route
              path="/eaos/onboarding"
              element={<div data-testid="onboarding-stub">onboarding</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("EaosCommandCenterRoute (LET-513 §1)", () => {
  it("redirects to /eaos/onboarding when the user has no companies", async () => {
    companyContext.companies = [];
    companyContext.loading = false;
    await renderRoute();
    await flushReact();
    expect(
      container?.querySelector('[data-testid="onboarding-stub"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-command-center-landing"]'),
    ).toBeNull();
  });

  it("renders the dashboard when at least one company exists", async () => {
    companyContext.companies = [
      { id: "c-1", name: "Acme", issuePrefix: "ACME", status: "active" },
    ];
    companyContext.loading = false;
    await renderRoute();
    await flushReact();
    expect(
      container?.querySelector('[data-testid="eaos-command-center-landing"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="onboarding-stub"]'),
    ).toBeNull();
  });

  it("shows a neutral loading state while the company list is loading", async () => {
    companyContext.companies = [];
    companyContext.loading = true;
    await renderRoute();
    await flushReact();
    expect(
      container?.querySelector('[data-testid="eaos-command-center-loading"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="onboarding-stub"]'),
    ).toBeNull();
  });
});
