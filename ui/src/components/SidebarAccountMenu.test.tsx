// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { SidebarAccountMenu as ProductionSidebarAccountMenu } from "./SidebarAccountMenu.production";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockGetCurrentBoardAccess = vi.hoisted(() => vi.fn());
const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));

vi.mock("@/api/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/access")>();
  return {
    ...actual,
    accessApi: { ...actual.accessApi, getCurrentBoardAccess: mockGetCurrentBoardAccess },
  };
});

vi.mock("@/context/CompanyContext", () => ({
  useOptionalCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: mockNavigateTopLevel,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    themePreference: "dark",
    toggleTheme: mockToggleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

/** Stack portfolio with the acme-labs stack current at the given Cloud role. */
function cloudStacksPortfolio(role: string) {
  return {
    stacks: [
      {
        displayName: "Acme Labs",
        stackSlug: "acme-labs",
        primaryHost: "acme-labs.example.test",
        lifecycleState: "active",
        sleepState: "awake",
        role,
        isCurrent: true,
      },
    ],
  };
}

/** Board access snapshot for a signed-in member of company-1 at the given company role. */
function boardAccess(
  membershipRole: "owner" | "admin" | "operator" | "viewer",
  overrides: { isInstanceAdmin?: boolean; source?: string } = {},
) {
  return {
    user: { id: "user-1", email: "jane@example.com", name: "Jane Example", image: null },
    userId: "user-1",
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole, status: "active" as const }],
    source: overrides.source ?? "session",
    keyId: null,
  };
}

describe("SidebarAccountMenu", () => {
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
        image: "https://example.com/jane.png",
      },
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
    });
    mockAuthApi.signOut.mockResolvedValue({ success: true, redirectTo: "/cloud/logout" });
    // Default to a company owner: the self-hosted Invite shortcut needs the
    // `users:invite` grant, which owners and admins hold.
    mockGetCurrentBoardAccess.mockResolvedValue(boardAccess("owner"));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe.each([SidebarAccountMenu, ProductionSidebarAccountMenu])("staging commit (%#)", (AccountMenu) => {
    const commit = "8751e2de4626ff5e7355fe28b30509991cfff920";

    it.each([
      ["paperclip.staging.paperclip.app", true],
      ["another.staging.paperclip.app", true],
      ["paperclip.paperclip.app", false],
      ["localhost", false],
      ["paperclip.staging.paperclip.app.example.com", false],
    ])("shows the running SHA only on staging: %s", async (hostname, visible) => {
      vi.stubGlobal("location", new URL(`https://${hostname}`));
      mockHealthApi.get.mockResolvedValue({ status: "ok", commit });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // Production must stay hidden even if the shared cache contains a commit.
      queryClient.setQueryData(queryKeys.health, { status: "ok", commit });
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <TooltipProvider><AccountMenu open /></TooltipProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();

      const label = document.body.querySelector(`a[title="${commit}"]`);
      expect(Boolean(label)).toBe(visible);
      if (visible) {
        expect(label?.textContent).toBe("SHA 8751e2d");
        expect(label?.previousElementSibling?.textContent).toBe("jane@example.com");
        expect(label?.getAttribute("href")).toBe(`https://github.com/paperclipai/paperclip/commit/${commit}`);
        expect(label?.getAttribute("aria-label")).toBe(`View commit ${commit} on GitHub`);
        expect(mockHealthApi.get).toHaveBeenCalledOnce();
      } else {
        expect(mockHealthApi.get).not.toHaveBeenCalled();
      }
      await act(() => root.unmount());
      queryClient.clear();
    });

    it("refreshes the running SHA each time the staging menu opens", async () => {
      vi.stubGlobal("location", new URL("https://paperclip.staging.paperclip.app"));
      const nextCommit = "3447609d2247e75e55d91493dda91a608364f672";
      mockHealthApi.get
        .mockResolvedValueOnce({ status: "ok", commit })
        .mockResolvedValueOnce({ status: "ok", commit: nextCommit });
      const queryClient = new QueryClient();
      const root = createRoot(container);
      const renderMenu = async (open: boolean) => {
        await act(() => {
          root.render(
            <QueryClientProvider client={queryClient}>
              <TooltipProvider><AccountMenu open={open} /></TooltipProvider>
            </QueryClientProvider>,
          );
        });
        await flushReact();
      };

      await renderMenu(false);
      expect(mockHealthApi.get).not.toHaveBeenCalled();
      await renderMenu(true);
      expect(document.body.textContent).toContain("SHA 8751e2d");
      await renderMenu(false);
      await renderMenu(true);
      expect(document.body.textContent).toContain("SHA 3447609");
      expect(document.body.textContent).not.toContain("SHA 8751e2d");
      expect(mockHealthApi.get).toHaveBeenCalledTimes(2);
      await act(() => root.unmount());
      queryClient.clear();
    });

    it("does not change the board health state when a menu refresh fails", async () => {
      vi.stubGlobal("location", new URL("https://paperclip.staging.paperclip.app"));
      mockHealthApi.get.mockRejectedValueOnce(new Error("Deploy in progress"));
      const queryClient = new QueryClient();
      const boardHealth = { status: "ok", commit };
      queryClient.setQueryData(queryKeys.health, boardHealth);
      queryClient.setQueryData(queryKeys.stagingCommit, boardHealth);
      const root = createRoot(container);
      await act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <TooltipProvider><AccountMenu open /></TooltipProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();

      expect(mockHealthApi.get).toHaveBeenCalledOnce();
      expect(queryClient.getQueryState(queryKeys.stagingCommit)?.status).toBe("error");
      expect(queryClient.getQueryState(queryKeys.health)?.status).toBe("success");
      expect(queryClient.getQueryData(queryKeys.health)).toEqual(boardHealth);
      expect(document.body.textContent).not.toContain("SHA ");
      await act(() => root.unmount());
      queryClient.clear();
    });

    it.each([null, undefined])("omits unavailable commit metadata (%s)", async (commit) => {
      vi.stubGlobal("location", new URL("https://paperclip.staging.paperclip.app"));
      mockHealthApi.get.mockResolvedValue({ status: "ok", commit });
      const queryClient = new QueryClient();
      const root = createRoot(container);
      await act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <TooltipProvider><AccountMenu open /></TooltipProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();
      expect(document.body.textContent).not.toContain("SHA ");
      await act(() => root.unmount());
      queryClient.clear();
    });
  });

  it("shares the nav background without separator borders", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="local_trusted" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const accountSurface = container.firstElementChild;
    expect(accountSurface?.className).toContain("bg-border/50");
    expect(accountSurface?.className).toContain("dark:bg-muted");
    expect(accountSurface?.className).not.toContain("border-t");
    expect(accountSurface?.className).not.toContain("border-r");
    expect(accountSurface?.className).not.toContain("border-border");
    const accountTrigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(accountTrigger?.classList).toContain("rounded-lg");
    expect(accountTrigger?.classList).toContain("hover:bg-sidebar-accent");
    expect(accountTrigger?.classList).toContain("hover:text-sidebar-accent-foreground");
    expect(accountTrigger?.classList).not.toContain("hover:bg-background");

    const feedbackButton = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Share feedback"]',
    );
    expect(feedbackButton?.getAttribute("href")).toBe("https://paperclip.ing/feedback");
    expect(feedbackButton?.getAttribute("target")).toBe("_blank");
    expect(feedbackButton?.classList).toContain("text-muted-foreground/50");
    expect(feedbackButton?.classList).not.toContain("text-border");
    expect(feedbackButton?.classList).not.toContain("text-muted-foreground");
    expect(feedbackButton?.classList).toContain("hover:bg-sidebar-accent");
    expect(feedbackButton?.classList).toContain("hover:text-sidebar-accent-foreground");
    expect(feedbackButton?.classList).not.toContain("hover:bg-background");
    expect(feedbackButton?.querySelector("svg")?.classList).toContain("lucide-flag");
    expect(feedbackButton?.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(feedbackButton?.hasAttribute("title")).toBe(false);

    await act(async () => root.unmount());
  });

  it("keeps the classic feedback control visible beside the profile trigger", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ProductionSidebarAccountMenu deploymentMode="local_trusted" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const accountTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open account menu"]',
    );
    expect(accountTrigger?.classList).toContain("rounded-lg");
    expect(accountTrigger?.classList).toContain("hover:bg-accent/50");

    const feedbackButton = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="Share feedback"]',
    );
    expect(feedbackButton?.getAttribute("href")).toBe("https://paperclip.ing/feedback");
    expect(feedbackButton?.getAttribute("target")).toBe("_blank");
    expect(feedbackButton?.classList).toContain("text-muted-foreground/50");
    expect(feedbackButton?.classList).not.toContain("text-border");
    expect(feedbackButton?.classList).not.toContain("text-muted-foreground");
    expect(feedbackButton?.classList).toContain("hover:bg-accent/50");
    expect(feedbackButton?.querySelector("svg")?.classList).toContain("lucide-flag");
    expect(feedbackButton?.getAttribute("data-slot")).toBe("tooltip-trigger");

    await act(async () => {
      accountTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).not.toContain("Feedback");
    expect(popover?.querySelector('a[href="https://paperclip.ing/feedback"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps authenticated self-hosted sign-out on the local auth flow", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="authenticated" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('a[aria-label="Share feedback"]')).not.toBeNull();
    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("jane@example.com");

    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Settings");
    expect(document.body.textContent).not.toContain("Instance settings");
    expect(document.body.textContent).toContain("Documentation");

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).not.toContain("Feedback");
    expect(popover?.querySelector('a[href="https://paperclip.ing/feedback"]')).toBeNull();

    // Profile access moved off the action list: the header links to the
    // profile, and the separate view/edit rows are gone. Editing lives on the
    // profile page itself.
    expect(popover?.textContent).not.toContain("View profile");
    expect(popover?.textContent).not.toContain("Edit profile");
    // The link resolves by user id, not display name: names are not unique,
    // and the profile endpoint returns the first member whose slug matches.
    const profileHeaderLink = popover?.querySelector<HTMLAnchorElement>('a[aria-label="View profile"]');
    expect(profileHeaderLink?.getAttribute("href")).toBe("/u/user-1");
    // The link is a stretched overlay over the header block (so the staging
    // SHA anchor can live beside the email without nesting anchors), so the
    // identity text is in the header block rather than inside the anchor.
    const profileHeader = profileHeaderLink?.parentElement;
    expect(profileHeader?.textContent).toContain("Jane Example");
    expect(profileHeader?.textContent).toContain("jane@example.com");
    expect(profileHeader?.querySelector("a a")).toBeNull();
    expect(popover?.querySelector('a[href="/company/settings/instance/profile"]')).toBeNull();

    // Self-hosted invites open the in-app Members page on its Invites tab.
    const inviteLink = popover?.querySelector<HTMLAnchorElement>(
      'a[href="/company/settings/members?tab=invites"]',
    );
    expect(inviteLink?.textContent).toBe("Invite");
    expect(inviteLink?.querySelector("svg")?.classList).toContain("lucide-user-plus");
    expect(inviteLink?.hasAttribute("target")).toBe(false);
    const menuOrder = popover?.textContent ?? "";
    expect(menuOrder.indexOf("Settings")).toBeLessThan(menuOrder.indexOf("Invite"));
    expect(menuOrder.indexOf("Invite")).toBeLessThan(menuOrder.indexOf("Documentation"));

    // Documentation still appears before the theme toggle.
    const menuText = popover?.textContent ?? "";
    const docsPos = menuText.indexOf("Documentation");
    const themePos = menuText.indexOf("Switch to");
    expect(docsPos).toBeLessThan(themePos);

    // The popover header stays down to name + email: no "Account" badge, no version line.
    expect(popover?.textContent).not.toContain("Account");
    expect(popover?.textContent).not.toContain("Paperclip v");
    expect(document.body.textContent).toContain("jane@example.com");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("w-(--profile-popover-width)");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("rounded-xl");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("min-h-(--profile-popover-min-height)");
    expect(document.body.querySelector('a[href="/company/settings"]')?.className)
      .not.toContain("bg-muted");
    expect(document.body.textContent).not.toContain("Manage company and instance settings.");
    expect(document.body.textContent).not.toContain("Open your activity, task, and usage ledger.");
    expect(document.body.querySelector('a[href="/company/settings"]')).not.toBeNull();

    const signOutButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Sign out"),
    );
    await act(async () => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).toHaveBeenCalledOnce();
    expect(mockNavigateTopLevel).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it.each([SidebarAccountMenu, ProductionSidebarAccountMenu])("hides cloud feedback and signs out through the harness (%#)", async (AccountMenu) => {
    const root = createRoot(container);
    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: "acme-labs",
        cloudBaseUrl: "https://cloud.example.test",
      },
    });
    queryClient.setQueryData(queryKeys.cloud.stacks, cloudStacksPortfolio("owner"));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AccountMenu
              deploymentMode="authenticated"
              open
              onOpenChange={onOpenChange}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('a[aria-label="Share feedback"]')).toBeNull();

    // Cloud manages invitations in the stack's People settings, reached with a
    // same-tab top-level navigation rather than the in-app router.
    const popover = document.body.querySelector('[data-slot="popover-content"]');
    const inviteLink = Array.from(popover?.querySelectorAll("a") ?? []).find(
      (anchor) => anchor.textContent?.includes("Invite"),
    );
    expect(inviteLink?.getAttribute("href")).toBe(
      "https://cloud.example.test/workspaces/acme-labs/settings?section=people",
    );
    expect(inviteLink?.hasAttribute("target")).toBe(false);
    expect(popover?.querySelector('a[href="/company/settings/members?tab=invites"]')).toBeNull();
    expect(popover?.querySelector('a[aria-label="View profile"]')?.getAttribute("href")).toBe("/u/user-1");
    expect(popover?.textContent).not.toContain("Edit profile");

    const signOutButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Sign out"),
    );
    await act(async () => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).not.toHaveBeenCalled();
    expect(mockNavigateTopLevel).toHaveBeenCalledOnce();
    expect(mockNavigateTopLevel).toHaveBeenCalledWith("/cloud/logout");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      root.unmount();
    });
  });

  it.each([SidebarAccountMenu, ProductionSidebarAccountMenu])("offers no cloud invite shortcut to members below stack admin (%#)", async (AccountMenu) => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: "acme-labs",
        cloudBaseUrl: "https://cloud.example.test",
      },
    });
    // Company roles can differ from Cloud roles; the Members page only offers
    // the Cloud invite link to the current stack's owner/admin, so the menu
    // must match rather than send a plain member to People settings.
    queryClient.setQueryData(queryKeys.cloud.stacks, cloudStacksPortfolio("member"));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AccountMenu deploymentMode="authenticated" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).not.toContain("Invite");
    expect(popover?.querySelector('a[href^="https://cloud.example.test/"]')).toBeNull();
    expect(popover?.querySelector('a[href="/company/settings/members?tab=invites"]')).toBeNull();
    expect(popover?.querySelector('a[aria-label="View profile"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it.each([SidebarAccountMenu, ProductionSidebarAccountMenu])("never falls back to in-app invites when cloud stack metadata is missing (%#)", async (AccountMenu) => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Managed instance whose health block lacks the stack slug: the portfolio
    // has no current stack either, so no Cloud People URL can be built. The
    // in-app Invites tab drives a different flow and must not appear instead.
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: null,
        cloudBaseUrl: "https://cloud.example.test",
      },
    });
    queryClient.setQueryData(queryKeys.cloud.stacks, { stacks: [] });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AccountMenu deploymentMode="authenticated" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).not.toContain("Invite");
    expect(popover?.querySelector('a[href="/company/settings/members?tab=invites"]')).toBeNull();
    expect(popover?.textContent).toContain("Documentation");

    await act(async () => {
      root.unmount();
    });
  });

  it.each([SidebarAccountMenu, ProductionSidebarAccountMenu])("hides the invite shortcut when the operator hides invites (%#)", async (AccountMenu) => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
      hiddenSettings: ["company.invites"],
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AccountMenu deploymentMode="authenticated" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).not.toContain("Invite");
    expect(popover?.querySelector('a[href="/company/settings/members?tab=invites"]')).toBeNull();
    // The settings-independent entries stay put.
    expect(popover?.querySelector('a[aria-label="View profile"]')).not.toBeNull();
    expect(popover?.textContent).toContain("Documentation");

    await act(async () => {
      root.unmount();
    });
  });

  it.each([SidebarAccountMenu, ProductionSidebarAccountMenu])("offers no self-hosted invite shortcut to members without the invite grant (%#)", async (AccountMenu) => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
    });
    // Operators and viewers lack `users:invite`; the Invites tab would only
    // show them a permission error, so the menu must not offer it.
    mockGetCurrentBoardAccess.mockResolvedValue(boardAccess("operator"));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AccountMenu deploymentMode="authenticated" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockGetCurrentBoardAccess).toHaveBeenCalledOnce();
    const popover = document.body.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).not.toContain("Invite");
    expect(popover?.querySelector('a[href="/company/settings/members?tab=invites"]')).toBeNull();
    expect(popover?.querySelector('a[aria-label="View profile"]')).not.toBeNull();
    expect(popover?.textContent).toContain("Documentation");

    await act(async () => {
      root.unmount();
    });
  });

  it.each([
    ["instance admin", boardAccess("viewer", { isInstanceAdmin: true })],
    ["local board", boardAccess("viewer", { source: "local_implicit" })],
    ["company admin", boardAccess("admin")],
  ])("offers the self-hosted invite shortcut to a %s", async (_label, access) => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
    });
    mockGetCurrentBoardAccess.mockResolvedValue(access);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="authenticated" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const popover = document.body.querySelector('[data-slot="popover-content"]');
    const inviteLink = popover?.querySelector<HTMLAnchorElement>(
      'a[href="/company/settings/members?tab=invites"]',
    );
    expect(inviteLink?.textContent).toBe("Invite");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps sign-out hidden outside authenticated deployment mode", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAccountMenu deploymentMode="local_trusted" open />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(document.body.textContent).not.toContain("Sign out");

    await act(async () => {
      root.unmount();
    });
  });

});
