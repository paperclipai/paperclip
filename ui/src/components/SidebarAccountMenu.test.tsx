// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAccountMenu } from "./SidebarAccountMenu";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockSetTheme = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
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
    setTheme: mockSetTheme,
    toggleTheme: vi.fn(),
  }),
}));

vi.mock("../context/LocaleContext", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    localeLabel: "English",
    t: (key: string) => ({
      "account.openMenu": "Open account menu",
      "account.viewProfile": "View profile",
      "account.editProfile": "Edit profile",
      "account.instanceSettings": "Instance settings",
      "account.documentation": "Documentation",
      "account.signOut": "Sign out",
      "account.signingOut": "Signing out...",
      "account.signOutDesc": "End this browser session.",
      "account.languageDesc": "Switch the UI language.",
      "account.appearanceDesc": "Choose the app appearance.",
      "common.language": "Language",
      "common.appearance": "Appearance",
      "common.light": "Light",
      "common.dark": "Dark",
      "account.badge.account": "Account",
      "account.badge.local": "Local",
      "account.signedIn": "Signed in",
      "account.localWorkspaceBoard": "Local workspace board",
      "account.viewProfileDesc": "Open your activity, task, and usage ledger.",
      "account.editProfileDesc": "Update your display name and avatar.",
      "account.instanceSettingsDesc": "Jump back to the last settings page you opened.",
      "account.documentationDesc": "Open Paperclip docs in a new tab.",
    }[key] ?? key),
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

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
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
    expect(document.body.textContent).toContain("Documentation");
    expect(document.body.textContent).toContain("Paperclip v1.2.3");
    expect(document.body.textContent).toContain("jane@example.com");

    await act(async () => {
      root.unmount();
    });
  });
});
