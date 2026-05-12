// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

const mockAuthApi = vi.hoisted(() => ({
  signOut: vi.fn(),
}));
const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("InstanceGeneralSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.signOut.mockResolvedValue(undefined);
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated", version: "1.2.3" });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: true,
      backupRetention: null,
      feedbackDataSharingPreference: "disabled",
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("clears cached authenticated data and pins the session to signed out on sign out", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["auth", "session"], {
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", name: "Jane Example", email: "jane@example.com", image: null },
    });
    queryClient.setQueryData(["access", "current-board-access"], { isInstanceAdmin: true });
    queryClient.setQueryData(["instance", "plugin-secrets"], [
      { id: "secret-1", name: "PLUGIN_TOKEN", createdByUserId: "plugin:gitea" },
    ]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const signOutButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Sign out"));
    await act(async () => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["access", "current-board-access"])).toBeUndefined();
    expect(queryClient.getQueryData(["instance", "plugin-secrets"])).toBeUndefined();
    expect(queryClient.getQueryData(["auth", "session"])).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
