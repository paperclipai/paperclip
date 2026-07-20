// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { SidebarAccountMenu } from "./SidebarAccountMenu";

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
const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
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
    mockAuthApi.signOut.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the signed-in user and opens the account card menu", async () => {
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
          <SidebarAccountMenu
            deploymentMode="authenticated"
            version="1.2.3"
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("jane@example.com");

    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Edit profile");
    expect(document.body.textContent).not.toContain("Instance settings");
    expect(document.body.textContent).toContain("Documentation");
    expect(document.body.textContent).toContain("Feedback");

    // Feedback link opens in a new tab pointing at the feedback URL
    const feedbackAnchor = document.body.querySelector('a[href="https://paperclip.ing/feedback"]') as HTMLAnchorElement | null;
    expect(feedbackAnchor).not.toBeNull();
    expect(feedbackAnchor?.getAttribute("target")).toBe("_blank");

    // Feedback appears after Documentation and before the theme toggle
    const menuText = document.body.querySelector('[data-slot="popover-content"]')?.textContent ?? "";
    const docsPos = menuText.indexOf("Documentation");
    const feedbackPos = menuText.indexOf("Feedback");
    const themePos = menuText.indexOf("Switch to");
    expect(docsPos).toBeLessThan(feedbackPos);
    expect(feedbackPos).toBeLessThan(themePos);

    expect(document.body.textContent).toContain("Paperclip v1.2.3");
    expect(document.body.textContent).toContain("jane@example.com");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("w-(--sz-277px)");
    expect(document.body.querySelector('a[href="/company/settings/instance/profile"]')).not.toBeNull();

    const signOutButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Sign out"),
    );
    await act(async () => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).toHaveBeenCalledOnce();
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the short commit sha instead of a version for source builds", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            version="2026.626.0+58.git.518fc71ce"
            serverGit={{
              available: true,
              fullSha: "518fc71ce1234567890abcdef1234567890abcde",
              shortSha: "518fc71",
              branchName: "feature/source-build-label",
              subject: "Show source build label",
              committedAt: "2026-06-26T00:00:00.000Z",
              localChanges: {
                available: true,
                hasLocalChanges: false,
                stagedFileCount: 0,
                unstagedFileCount: 0,
                untrackedFileCount: 0,
              },
            }}
            open
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(document.body.textContent).toContain("feature/source-build-labelPaperclip 518fc71");
    expect(document.body.textContent).not.toContain("2026.626.0+58.git.518fc71ce");
    expect(document.body.querySelector('a[href="https://github.com/paperclipai/paperclip/tree/feature%2Fsource-build-label"]')?.textContent).toBe(
      "feature/source-build-label",
    );
    expect(document.body.querySelector('a[href="https://github.com/paperclipai/paperclip/commit/518fc71ce1234567890abcdef1234567890abcde"]')?.textContent).toBe(
      "518fc71",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
