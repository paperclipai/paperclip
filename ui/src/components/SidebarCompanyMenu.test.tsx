// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenOnboarding = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({ pathname: "/PAP/dashboard" }));
const mockSidebarPreferencesApi = vi.hoisted(() => ({
  getCompanyOrder: vi.fn(),
  updateCompanyOrder: vi.fn(),
}));
const mockCloudApi = vi.hoisted(() => ({
  listStacks: vi.fn(),
}));
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/cloud", () => ({
  cloudApi: mockCloudApi,
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: mockNavigateTopLevel,
}));

vi.mock("@/api/sidebarPreferences", () => ({
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}));

// Overridable so the list-unavailable branch can be exercised; null means "use
// the default three companies below".
const mockCompanyState = vi.hoisted(() => ({
  companies: null as unknown[] | null,
  companyListUnavailable: false,
  retryCompanies: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companyListUnavailable: mockCompanyState.companyListUnavailable,
    retryCompanies: mockCompanyState.retryCompanies,
    companies: mockCompanyState.companies ?? [
      {
        id: "company-1",
        issuePrefix: "PAP",
        name: "Acme Labs",
        brandColor: "#3366ff",
        status: "active",
      },
      {
        id: "company-2",
        issuePrefix: "STR",
        name: "Strata",
        brandColor: "#36a269",
        status: "active",
      },
      {
        id: "company-3",
        issuePrefix: "ANA",
        name: "Anachronist Wiki",
        brandColor: "#a36a21",
        status: "active",
      },
    ],
    selectedCompany: {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Acme Labs",
      brandColor: "#3366ff",
      logoUrl: "/api/assets/logo-asset-1/content",
      status: "active",
    },
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({
    openOnboarding: mockOpenOnboarding,
  }),
}));

vi.mock("./CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName, logoUrl }: { companyName: string; logoUrl?: string | null }) => (
    <span aria-hidden="true" data-logo-url={logoUrl ?? undefined}>{companyName.slice(0, 1)}</span>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

const CLOUD_HEALTH = {
  status: "ok" as const,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme-labs",
    cloudBaseUrl: "https://cloud.example.test",
  },
};

const CLOUD_STACKS = {
  stacks: [
    {
      displayName: "Acme Labs",
      stackSlug: "acme-labs",
      primaryHost: "acme-labs.example.test",
      lifecycleState: "active",
      sleepState: "awake",
      role: "owner",
      isCurrent: true,
    },
    {
      displayName: "Strata Systems",
      stackSlug: "strata",
      primaryHost: "strata.example.test",
      lifecycleState: "active",
      sleepState: "asleep",
      role: "member",
      isCurrent: false,
    },
  ],
};

describe("SidebarCompanyMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
      },
    });
    mockAuthApi.signOut.mockResolvedValue(undefined);
    mockCloudApi.listStacks.mockResolvedValue(CLOUD_STACKS);
    mockSidebarPreferencesApi.getCompanyOrder.mockResolvedValue({
      orderedIds: ["company-1", "company-2", "company-3"],
      updatedAt: null,
    });
    mockSidebarPreferencesApi.updateCompanyOrder.mockResolvedValue({
      orderedIds: ["company-1", "company-2", "company-3"],
      updatedAt: null,
    });
    mockLocation.pathname = "/PAP/dashboard";
    mockCompanyState.companies = null;
    mockCompanyState.companyListUnavailable = false;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function renderMenu(options: { cloud?: boolean; health?: unknown } = {}) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // CloudAccessGate owns the health fetch in the app; seeding the cache is how
    // useCloudInstance sees a cloud-managed instance under test.
    if (options.cloud || options.health) {
      queryClient.setQueryData(queryKeys.health, options.health ?? CLOUD_HEALTH);
    }
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    return { root, queryClient };
  }

  async function openMenu(ariaLabel: string) {
    const trigger = container.querySelector(`button[aria-label="${ariaLabel}"]`);
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  // This menu is the one the app renders, so it is the only place a customer can
  // act on a failed company list. Saying "No companies" there states something
  // about the account that a failed request cannot support, and leaves the tab
  // with no way back short of a browser reload.
  it("offers a way back when the company list could not be loaded", async () => {
    mockCompanyState.companies = [];
    mockCompanyState.companyListUnavailable = true;

    const { root } = renderMenu();
    await flushReact();
    await openMenu("Open Acme Labs organization switcher");

    expect(document.body.textContent).toContain("Couldn't load organizations");
    expect(document.body.textContent).not.toContain("No organizations");

    const retryItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes("Try again"),
    );
    expect(retryItem).not.toBeUndefined();

    act(() => {
      retryItem?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      retryItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompanyState.retryCompanies).toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("still reports an account that owns no companies as empty, not broken", async () => {
    mockCompanyState.companies = [];
    mockCompanyState.companyListUnavailable = false;

    const { root } = renderMenu();
    await flushReact();
    await openMenu("Open Acme Labs organization switcher");

    expect(document.body.textContent).toContain("No organizations");
    expect(document.body.textContent).not.toContain("Couldn't load organizations");

    act(() => {
      root.unmount();
    });
  });

  it("uses company-centric create copy without the chat flag", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs organization switcher"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Create new organization...");
    expect(document.body.textContent).not.toContain("Add company...");

    act(() => {
      root.unmount();
    });
  });

  it("shows the requested company actions and signs out through the dropdown", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Acme Labs");

    const trigger = container.querySelector('button[aria-label="Open Acme Labs organization switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Switch organization");
    expect(document.body.textContent).toContain("Edit");
    expect(document.body.textContent).toContain("Strata");
    expect(document.body.textContent).toContain("ANA");
    expect(document.body.textContent).toContain("Create new organization...");
    expect(document.body.textContent).toContain("Invite people to Acme Labs");
    expect(document.body.textContent).not.toContain("Company settings");
    expect(document.body.textContent).toContain("Sign out");

    const signOutButton = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Sign out"));
    expect(signOutButton).toBeTruthy();

    act(() => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).toHaveBeenCalledTimes(1);
    expect(mockNavigateTopLevel).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(true);
    expect(document.body.textContent).not.toContain("Switch organization");

    act(() => {
      root.unmount();
    });
  });

  it("toggles company order editing without selecting a company", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs organization switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const editButton = Array.from(document.body.querySelectorAll("button"))
      .find((element) => element.textContent === "Edit");
    expect(editButton).toBeTruthy();

    act(() => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Done");
    expect(document.body.textContent).not.toContain("PAP");
    expect(document.body.textContent).not.toContain("ANA");
    expect(document.body.querySelector('button[aria-label="Reorder Strata"]')).toBeTruthy();

    const strataItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Strata"));
    expect(strataItem).toBeTruthy();

    act(() => {
      strataItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSetSelectedCompanyId).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("navigates to the selected company dashboard from company-prefixed routes", async () => {
    mockLocation.pathname = "/PAP/issues";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs organization switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const strataItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Strata"));
    expect(strataItem).toBeTruthy();

    act(() => {
      strataItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSetSelectedCompanyId).toHaveBeenCalledWith("company-2");
    expect(mockNavigate).toHaveBeenCalledWith("/STR/dashboard");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the in-app company wizard and never leaves the app when self-hosted", async () => {
    const { root } = renderMenu();
    await flushReact();
    await flushReact();

    await openMenu("Open Acme Labs organization switcher");

    const createItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Create new organization..."));
    expect(createItem).toBeTruthy();

    act(() => {
      createItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockOpenOnboarding).toHaveBeenCalledTimes(1);
    expect(mockNavigateTopLevel).not.toHaveBeenCalled();
    expect(mockCloudApi.listStacks).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  // The trigger sits in a fixed 240px sidebar header beside two shrink-0
  // controls, so a long name may only truncate — never widen the row and push
  // the chevron, search, and collapse controls out of the panel. Truncation
  // needs `min-w-0` on EVERY flex link of the chain (a flex item's default
  // `min-width:auto` floors it at its content width), which is invisible to
  // behavioural assertions, so the class chain itself is the contract.
  it("lets a long workspace name truncate instead of widening the trigger", async () => {
    const { root } = renderMenu();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs organization switcher"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.className).toContain("min-w-0");

    const labelRow = trigger?.firstElementChild;
    expect(labelRow?.className).toContain("min-w-0");

    const label = labelRow?.lastElementChild;
    expect(label?.textContent).toBe("Acme Labs");
    expect(label?.className).toContain("min-w-0");
    expect(label?.className).toContain("truncate");
    // A truncated name stays recoverable on hover.
    expect(label?.getAttribute("title")).toBe("Acme Labs");

    act(() => {
      root.unmount();
    });
  });

  describe("in Paperclip Cloud", () => {
    it("closes the menu and enters the Cloud logout flow without local sign-out", async () => {
      const { root } = renderMenu({ cloud: true });
      await flushReact();
      await flushReact();
      await openMenu("Open Acme Labs organization switcher");

      const signOutItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
        .find((element) => element.textContent?.includes("Sign out"));
      expect(signOutItem).toBeTruthy();

      act(() => {
        signOutItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(mockAuthApi.signOut).not.toHaveBeenCalled();
      expect(mockNavigateTopLevel).toHaveBeenCalledOnce();
      expect(mockNavigateTopLevel).toHaveBeenCalledWith("/cloud/logout");
      expect(document.body.textContent).not.toContain("Switch organization");

      act(() => {
        root.unmount();
      });
    });

    it("switches organizations instead of companies", async () => {
      const { root } = renderMenu({ cloud: true });
      await flushReact();
      await flushReact();

      expect(mockCloudApi.listStacks).toHaveBeenCalledTimes(1);
      await openMenu("Open Acme Labs organization switcher");

      expect(document.body.textContent).toContain("Switch organization");
      expect(document.body.textContent).toContain("Create new organization...");
      expect(document.body.textContent).not.toContain("Organization settings");
      expect(document.body.textContent).not.toContain("Switch company");
      expect(document.body.textContent).not.toContain("Create new company...");
      expect(document.body.textContent).not.toContain("Company settings");

      // Stacks, not companies: both rows carry the slug badge, and the current
      // stack is the checked one.
      expect(document.body.textContent).toContain("Acme Labs");
      expect(document.body.textContent).toContain("acme-labs");
      expect(document.body.textContent).toContain("Strata Systems");
      expect(document.body.textContent).toContain("strata");
      expect(document.body.textContent).not.toContain("Anachronist Wiki");
      expect(document.body.textContent).not.toContain("ANA");

      const currentRow = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
        .find((element) => element.textContent?.includes("Acme Labs"));
      expect(currentRow?.className).toContain("bg-accent");

      // Long slugs must not squeeze the display name out of the row, so the
      // badge truncates and keeps the full slug on hover.
      const slugBadge = document.body.querySelector('[title="strata"]');
      expect(slugBadge?.className).toContain("truncate");

      // Drag-to-reorder is self-hosted only in v1.
      expect(Array.from(document.body.querySelectorAll("button"))
        .some((element) => element.textContent === "Edit")).toBe(false);

      act(() => {
        root.unmount();
      });
    });

    it("shows the synced company logo on the trigger while stack rows keep monograms", async () => {
      const { root } = renderMenu({ cloud: true });
      await flushReact();
      await flushReact();

      // A Cloud tenant holds exactly one company, and the harness pushes the
      // stack's uploaded workspace icon into that company's branding — so the
      // trigger renders the company logo, not the monogram.
      const trigger = container.querySelector(
        'button[aria-label="Open Acme Labs organization switcher"]',
      );
      expect(trigger).not.toBeNull();
      expect(
        trigger?.querySelector('[data-logo-url="/api/assets/logo-asset-1/content"]'),
      ).not.toBeNull();

      // Other stacks have no hot-linkable icon in the portfolio payload, so
      // their rows keep the deterministic monogram treatment.
      await openMenu("Open Acme Labs organization switcher");
      const strataRow = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
        .find((element) => element.textContent?.includes("Strata Systems"));
      expect(strataRow).toBeTruthy();
      expect(strataRow?.querySelector("[data-logo-url]")).toBeNull();

      act(() => {
        root.unmount();
      });
    });

    it("enters another stack through a full top-level navigation", async () => {
      const { root } = renderMenu({ cloud: true });
      await flushReact();
      await flushReact();
      await openMenu("Open Acme Labs organization switcher");

      const strataRow = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
        .find((element) => element.textContent?.includes("Strata Systems"));
      expect(strataRow).toBeTruthy();

      act(() => {
        strataRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(mockNavigateTopLevel).toHaveBeenCalledWith(
        "https://cloud.example.test/stacks/strata/enter",
      );
      // No in-app company selection and no client-side route change.
      expect(mockSetSelectedCompanyId).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();

      act(() => {
        root.unmount();
      });
    });

    it("does not navigate when the current stack is picked again", async () => {
      const { root } = renderMenu({ cloud: true });
      await flushReact();
      await flushReact();
      await openMenu("Open Acme Labs organization switcher");

      const currentRow = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
        .find((element) => element.textContent?.includes("Acme Labs"));

      act(() => {
        currentRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(mockNavigateTopLevel).not.toHaveBeenCalled();

      act(() => {
        root.unmount();
      });
    });

    it("sends organization creation to the cloud app, not the in-app wizard", async () => {
      const { root } = renderMenu({ cloud: true });
      await flushReact();
      await flushReact();
      await openMenu("Open Acme Labs organization switcher");

      const createItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
        .find((element) => element.textContent?.includes("Create new organization..."));
      expect(createItem).toBeTruthy();

      act(() => {
        createItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(mockNavigateTopLevel).toHaveBeenCalledWith("https://cloud.example.test/stacks/new");
      expect(mockOpenOnboarding).not.toHaveBeenCalled();

      act(() => {
        root.unmount();
      });
    });

    it("falls back to the stack slug and hides creation without a cloud base url", async () => {
      mockCloudApi.listStacks.mockRejectedValue(new Error("portfolio unavailable"));
      const { root } = renderMenu({
        cloud: true,
        health: {
          status: "ok" as const,
          cloud: { ...CLOUD_HEALTH.cloud, cloudBaseUrl: null },
        },
      });
      await flushReact();
      await flushReact();

      await openMenu("Open acme-labs organization switcher");

      expect(document.body.textContent).toContain("Could not load organizations");
      expect(document.body.textContent).not.toContain("Create new organization...");

      act(() => {
        root.unmount();
      });
    });
  });
});
