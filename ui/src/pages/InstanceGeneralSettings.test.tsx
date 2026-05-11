// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  signOut: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const defaultGeneralSettings = {
  censorUsernameInLogs: false,
  keyboardShortcuts: false,
  feedbackDataSharingPreference: "prompt",
  backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 6 },
  containerEngine: {
    driver: "disabled",
    networkMode: "none",
    allowRootUser: false,
    memoryMbMax: 4096,
    maxLifetimeSecMax: 86400,
    concurrencyPerPlugin: 10,
  },
};

describe("InstanceGeneralSettings — container engine section", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getGeneral.mockResolvedValue(defaultGeneralSettings);
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "local_trusted", authReady: true, bootstrapStatus: "ready", bootstrapInviteActive: false });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the container engine section heading", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Container engine");

    await act(async () => { root.unmount(); });
  });

  it("shows the driver selector", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const select = container.querySelector("select[name='containerEngine.driver']");
    expect(select).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe("disabled");

    await act(async () => { root.unmount(); });
  });

  it("shows the concurrencyPerPlugin value in the input", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const input = container.querySelector("input[name='containerEngine.concurrencyPerPlugin']") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input?.value).toBe("10");

    await act(async () => { root.unmount(); });
  });
});
