// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

const mockAuthApi = vi.hoisted(() => ({ signOut: vi.fn() }));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: mockNavigateTopLevel }));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SELF_HOSTED_HEALTH = {
  status: "ok" as const,
  deploymentMode: "authenticated" as const,
  deploymentExposure: "private" as const,
  authReady: true,
  bootstrapStatus: "ready" as const,
  bootstrapInviteActive: false,
};

const CLOUD_HEALTH = {
  ...SELF_HOSTED_HEALTH,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme",
    cloudBaseUrl: "https://cloud.example.test",
  },
};

describe("InstanceGeneralSettings sign-out", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "not_allowed",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    });
    mockInstanceSettingsApi.updateGeneral.mockResolvedValue(undefined);
    mockAuthApi.signOut.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage(health: typeof SELF_HOSTED_HEALTH | typeof CLOUD_HEALTH) {
    mockHealthApi.get.mockResolvedValue(health);
    queryClient.setQueryData(queryKeys.health, health);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Deployment and auth"));
  }

  function signOutButton() {
    return Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Sign out");
  }

  it("uses the Cloud-managed top-level logout without calling local auth", async () => {
    await renderPage(CLOUD_HEALTH);

    flushSync(() => signOutButton()?.click());

    await vi.waitFor(() => expect(mockNavigateTopLevel).toHaveBeenCalledOnce());
    expect(mockNavigateTopLevel).toHaveBeenCalledWith("/cloud/logout");
    expect(mockAuthApi.signOut).not.toHaveBeenCalled();
  });

  it("keeps authenticated self-hosted sign-out local and drops the account caches", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    await renderPage(SELF_HOSTED_HEALTH);
    queryClient.setQueryData(queryKeys.auth.session, { session: { id: "session-1" } });
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [{ id: "company-a", name: "Account A Co" }],
      unauthorized: false,
    });

    flushSync(() => signOutButton()?.click());

    await vi.waitFor(() => expect(mockAuthApi.signOut).toHaveBeenCalledOnce());
    // Account-scoped entries are cleared outright, not marked stale — a stale
    // entry keeps serving the previous account's data until a refetch succeeds.
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.auth.session)).toBeUndefined(),
    );
    expect(queryClient.getQueryData(queryKeys.companies.all)).toBeUndefined();
    // Health describes the instance, so it is refreshed rather than dropped.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.health });
    expect(queryClient.getQueryData(queryKeys.health)).toEqual(SELF_HOSTED_HEALTH);
    expect(mockNavigateTopLevel).not.toHaveBeenCalled();
  });

  it("shows a current sign-out failure instead of a stale settings error", async () => {
    mockInstanceSettingsApi.updateGeneral.mockRejectedValue(new Error("Settings update failed"));
    mockAuthApi.signOut.mockRejectedValue(new Error("Sign-out request failed"));
    await renderPage(SELF_HOSTED_HEALTH);

    const keyboardToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle keyboard shortcuts"]',
    );
    flushSync(() => keyboardToggle?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Settings update failed"));

    flushSync(() => signOutButton()?.click());

    await vi.waitFor(() => expect(container.textContent).toContain("Sign-out request failed"));
    expect(container.textContent).not.toContain("Settings update failed");
  });

  it("clears a stale sign-out failure after a settings update succeeds", async () => {
    mockAuthApi.signOut.mockRejectedValue(new Error("Sign-out request failed"));
    await renderPage(SELF_HOSTED_HEALTH);

    flushSync(() => signOutButton()?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Sign-out request failed"));

    const keyboardToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle keyboard shortcuts"]',
    );
    flushSync(() => keyboardToggle?.click());

    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Sign-out request failed"));
  });

  it("disables settings changes while sign-out is pending", async () => {
    let resolveSignOut: ((result: { success: boolean }) => void) | undefined;
    mockAuthApi.signOut.mockImplementation(
      () => new Promise<{ success: boolean }>((resolve) => {
        resolveSignOut = resolve;
      }),
    );
    await renderPage(SELF_HOSTED_HEALTH);

    const keyboardToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle keyboard shortcuts"]',
    );
    flushSync(() => signOutButton()?.click());
    await vi.waitFor(() => expect(mockAuthApi.signOut).toHaveBeenCalledOnce());

    expect(keyboardToggle?.disabled).toBe(true);
    flushSync(() => keyboardToggle?.click());
    expect(mockInstanceSettingsApi.updateGeneral).not.toHaveBeenCalled();

    resolveSignOut?.({ success: true });
    await vi.waitFor(() => expect(keyboardToggle?.disabled).toBe(false));
  });

  it("disables sign-out while a settings update is pending", async () => {
    let resolveSettings: (() => void) | undefined;
    mockInstanceSettingsApi.updateGeneral.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    await renderPage(SELF_HOSTED_HEALTH);

    const keyboardToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle keyboard shortcuts"]',
    );
    flushSync(() => keyboardToggle?.click());
    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());

    expect(signOutButton()?.disabled).toBe(true);
    flushSync(() => signOutButton()?.click());
    expect(mockAuthApi.signOut).not.toHaveBeenCalled();

    resolveSettings?.();
    await vi.waitFor(() => expect(signOutButton()?.disabled).toBe(false));
  });
});
