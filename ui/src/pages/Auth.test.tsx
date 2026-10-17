// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { AuthPage } from "./Auth";

const getSessionMock = vi.hoisted(() => vi.fn());
const signInEmailMock = vi.hoisted(() => vi.fn());
const signUpEmailMock = vi.hoisted(() => vi.fn());
const healthMock = vi.hoisted(() => vi.fn());
const beginCloudSignInMock = vi.hoisted(() => vi.fn());

vi.mock("../api/health", () => ({ healthApi: { get: () => healthMock() } }));
vi.mock("@/lib/cloud-sign-in", () => ({
  beginCloudSignIn: (url: string) => beginCloudSignInMock(url),
  clearCloudSignInAttempt: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInEmail: (input: unknown) => signInEmailMock(input),
    signUpEmail: (input: unknown) => signUpEmailMock(input),
  },
}));

// The ASCII art animation drives a canvas/requestAnimationFrame loop that adds
// nothing to these assertions, so stub it out.
vi.mock("@/components/AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => null,
}));

// The auth page renders a ThemeToggle, which reads ThemeContext. The provider
// lives in main.tsx (above the router), so mock the hook here the same way
// SidebarAccountMenu.test.tsx does.
vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
}));

// The router's navigate wrapper reads the active company prefix from context.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  flushSync(() => {});
}

function renderAuthPage(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { root, queryClient };
}

describe("AuthPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getSessionMock.mockResolvedValue(null);
    healthMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    beginCloudSignInMock.mockReturnValue(true);
    signInEmailMock.mockResolvedValue(undefined);
    signUpEmailMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function mount(path = "/auth") {
    const { root, queryClient } = renderAuthPage(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/auth" element={<AuthPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();
    return { root, queryClient };
  }

  it.each(["https://my.paperclip.app", "https://my-staging.paperclip.app"])("recovers Cloud auth through %s without rendering an instance form", async (origin) => {
    healthMock.mockResolvedValue({ cloud: { managed: true, managedBy: "paperclip-cloud", cloudBaseUrl: origin, stackSlug: "team" } });
    const { root } = await mount("/auth?next=%2FTEST%2Fissues%2FTEST-1%3Ftab%3Dactivity%23comment");
    await vi.waitFor(() => expect(beginCloudSignInMock).toHaveBeenCalledTimes(1));
    const target = new URL(beginCloudSignInMock.mock.calls[0][0]);
    expect(target.origin).toBe(origin);
    expect(target.pathname).toBe("/v1/stacks/team/entry-redirect");
    expect(target.searchParams.get("returnTo")).toBe("/TEST/issues/TEST-1?tab=activity#comment");
    expect(container.querySelector("form")).toBeNull();
    await act(() => root.unmount());
  });

  it("never flashes a form while deployment metadata is loading", async () => {
    healthMock.mockReturnValue(new Promise(() => {}));
    const { root } = await mount();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Loading");
    await act(() => root.unmount());
  });

  it("fails closed when deployment metadata cannot be loaded", async () => {
    healthMock.mockRejectedValue(new Error("offline"));
    const { root } = await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Unable to check sign-in"));
    expect(container.querySelector("form")).toBeNull();
    await act(() => root.unmount());
  });

  it("offers a manual Cloud retry after the automatic recovery limit", async () => {
    healthMock.mockResolvedValue({ cloud: { managed: true, managedBy: "paperclip-cloud", cloudBaseUrl: "https://my.paperclip.app", stackSlug: "team" } });
    beginCloudSignInMock.mockReturnValue(false);
    const { root } = await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Continue to Paperclip Cloud"));
    expect(container.querySelector("form")).toBeNull();
    await act(() => root.unmount());
  });

  it("keeps incomplete Cloud configuration out of the instance form", async () => {
    healthMock.mockResolvedValue({ cloud: { managed: true, managedBy: "paperclip-cloud", cloudBaseUrl: null, stackSlug: null } });
    const { root } = await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Cloud sign-in is unavailable"));
    expect(container.querySelector("form")).toBeNull();
    expect(beginCloudSignInMock).not.toHaveBeenCalled();
    await act(() => root.unmount());
  });

  it("exposes password-manager metadata and a11y attributes on the sign-in form", async () => {
    const { root } = await mount();

    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement;

    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    // 1Password / password-manager recognition: identifier field is "username".
    expect(emailInput.getAttribute("autocomplete")).toBe("username");
    expect(emailInput.getAttribute("type")).toBe("email");
    expect(passwordInput.getAttribute("autocomplete")).toBe("current-password");

    // Stable ids/names for both inputs.
    expect(emailInput.id).toBe("email");
    expect(passwordInput.id).toBe("password");

    // Required + programmatic required state.
    expect(emailInput.required).toBe(true);
    expect(emailInput.getAttribute("aria-required")).toBe("true");
    expect(passwordInput.required).toBe(true);
    expect(passwordInput.getAttribute("aria-required")).toBe("true");

    // Programmatic labels.
    expect(container.querySelector('label[for="email"]')).not.toBeNull();
    expect(container.querySelector('label[for="password"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("uses new-password autocomplete in sign-up mode", async () => {
    const { root } = await mount();

    const createOne = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create one",
    );
    expect(createOne).not.toBeNull();

    await act(async () => {
      createOne?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.getAttribute("autocomplete")).toBe("name");
    expect(nameInput.required).toBe(true);
    expect(passwordInput.getAttribute("autocomplete")).toBe("new-password");

    await act(async () => {
      root.unmount();
    });
  });

  it("tells visitors that registration is by invitation only instead of offering a sign-up form", async () => {
    healthMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", authSignUpMode: "invite" });
    const { root } = await mount();

    expect(container.querySelector('input[name="email"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Create one")).toBe(false);
    expect(container.querySelector('[data-testid="auth-sign-up-unavailable"]')?.textContent).toContain(
      "Registration on this instance is by invitation only.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not offer sign-up when registration is disabled", async () => {
    healthMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", authSignUpMode: "disabled" });
    const { root } = await mount();

    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Create one")).toBe(false);
    expect(container.querySelector('[data-testid="auth-sign-up-unavailable"]')?.textContent).toContain(
      "Registration of new accounts is closed on this instance.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the sign-up option in open mode", async () => {
    healthMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", authSignUpMode: "open" });
    const { root } = await mount();

    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Create one")).toBe(true);
    expect(container.querySelector('[data-testid="auth-sign-up-unavailable"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("returns an open sign-up form to sign-in when registration closes", async () => {
    healthMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", authSignUpMode: "open" });
    const { root, queryClient } = await mount();
    const createOne = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Create one");
    await act(async () => {
      createOne?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(container.querySelector('input[name="name"]')).not.toBeNull();

    // A later health refresh sees that registration is now by invitation only.
    healthMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", authSignUpMode: "invite" });
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('input[name="name"]')).toBeNull();
    expect(container.querySelector("form")?.getAttribute("action")).toBe("/api/auth/sign-in/email");
    expect(container.querySelector('[data-testid="auth-sign-up-unavailable"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders auth errors in an assertive alert region referenced by the inputs", async () => {
    const { root } = await mount();

    const inputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement;

    await act(async () => {
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "wrongpass");
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    signInEmailMock.mockRejectedValueOnce(new Error("Invalid email or password"));

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(alert.hasAttribute("aria-live")).toBe(false);
    expect(alert.textContent).toContain("Invalid email or password");

    const errorId = alert.id;
    expect(errorId.length).toBeGreaterThan(0);
    expect(emailInput.getAttribute("aria-describedby")).toBe(errorId);
    expect(emailInput.getAttribute("aria-invalid")).toBe("true");
    expect(passwordInput.getAttribute("aria-describedby")).toBe(errorId);
    expect(passwordInput.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      root.unmount();
    });
  });

  it("invalidates anonymous health metadata after sign-in", async () => {
    const { root, queryClient } = await mount();
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
    });

    const inputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement;

    await act(async () => {
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "supersecret");
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(healthMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
    });
  });
});
