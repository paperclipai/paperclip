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
const verifyTotpMock = vi.hoisted(() => vi.fn());
const verifyBackupCodeMock = vi.hoisted(() => vi.fn());
const getProvidersMock = vi.hoisted(() => vi.fn());
const signInGoogleMock = vi.hoisted(() => vi.fn());

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
    verifyTotp: (code: string) => verifyTotpMock(code),
    verifyBackupCode: (code: string) => verifyBackupCodeMock(code),
    getProviders: () => getProvidersMock(),
    signInGoogle: (opts: unknown) => signInGoogleMock(opts),
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
    signInEmailMock.mockResolvedValue({});
    signUpEmailMock.mockResolvedValue(undefined);
    verifyTotpMock.mockResolvedValue({ status: true });
    verifyBackupCodeMock.mockResolvedValue({ token: "session-token" });
    getProvidersMock.mockResolvedValue({ ssoProviders: [], googleSsoEnabled: false });
    signInGoogleMock.mockResolvedValue({ url: "https://accounts.google.com/x", redirect: true });
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

    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "supersecret",
    });

    // The health query is still observed on the auth page, so the post-sign-in
    // invalidation auto-refetches and clears; assert the fetch went out instead.
    await vi.waitFor(() => expect(healthMock.mock.calls.length).toBeGreaterThan(1));

    await act(async () => {
      root.unmount();
    });
  });

  it("completes a gated sign-in through the TOTP step instead of navigating away", async () => {
    const { root, queryClient } = await mount();
    // Seed health so invalidateQueries has a cache entry to mark; the active
    // auth.session observer auto-refetches on invalidation and clears itself.
    queryClient.setQueryData(queryKeys.health, { status: "ok" });

    signInEmailMock.mockResolvedValueOnce({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
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

    // The password step is gone and the challenge step is shown instead.
    expect(container.querySelector('input[name="password"]')).toBeNull();
    const codeInput = container.querySelector(
      'input[name="two-factor-code"]',
    ) as HTMLInputElement;
    expect(codeInput).not.toBeNull();
    expect(codeInput.getAttribute("autocomplete")).toBe("one-time-code");
    expect(container.textContent).toContain("Two-factor verification");

    // No session query invalidation yet — completion waits for the code.
    expect(queryClient.getQueryState(queryKeys.auth.session)?.isInvalidated).toBeFalsy();

    // Backup-code fallback link swaps the step.
    const backupLink = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Use a backup code instead",
    );
    expect(backupLink).not.toBeNull();
    await act(async () => {
      backupLink?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(container.querySelector('input[name="two-factor-code"]')).not.toBeNull();
    expect(container.textContent).toContain("Backup code");

    // Back to TOTP, then verify.
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Use my authenticator app instead",
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await act(async () => {
      inputValueSetter!.call(codeInput, "123456");
      codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const challengeForm = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      challengeForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(verifyTotpMock).toHaveBeenCalledWith("123456");
    expect(verifyBackupCodeMock).not.toHaveBeenCalled();
    // auth.session is auto-refetched by its active observer during
    // completeTwoFactor; the health query is refetched the same way.
    await vi.waitFor(() => expect(healthMock.mock.calls.length).toBeGreaterThan(1));

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps a Cloud deployment on the Cloud sign-in view even when two-factor would gate sign-in", async () => {
    healthMock.mockResolvedValue({ cloud: { managed: true, managedBy: "paperclip-cloud", cloudBaseUrl: "https://my.paperclip.app", stackSlug: "team" } });
    const { root } = await mount();
    await vi.waitFor(() => expect(beginCloudSignInMock).toHaveBeenCalledTimes(1));
    // Cloud deployment: the Cloud sign-in view (which shows a loading spinner
    // while the redirect is in flight) replaces the instance form entirely, so
    // the two-factor gate and the password form are never rendered.
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('input[name="two-factor-code"]')).toBeNull();
    await act(() => root.unmount());
  });

  it("completes a gated sign-in with a one-time backup code", async () => {
    const { root } = await mount();

    signInEmailMock.mockResolvedValueOnce({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
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

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Use a backup code instead",
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const codeInput = container.querySelector(
      'input[name="two-factor-code"]',
    ) as HTMLInputElement;
    await act(async () => {
      inputValueSetter!.call(codeInput, "abcd1234");
      codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const challengeForm = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      challengeForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(verifyBackupCodeMock).toHaveBeenCalledWith("abcd1234");
    expect(verifyTotpMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the Google sign-in button when googleSsoEnabled is false", async () => {
    getProvidersMock.mockResolvedValue({ ssoProviders: [], googleSsoEnabled: false });
    const { root } = await mount();
    await flushReact();
    await flushReact();
    const googleButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign in with Google",
    );
    expect(googleButton).toBeUndefined();
    await act(() => root.unmount());
  });

  it("shows the Google sign-in button when googleSsoEnabled is true and calls signInGoogle on click", async () => {
    getProvidersMock.mockResolvedValue({ ssoProviders: ["google"], googleSsoEnabled: true });
    const { root } = await mount("/auth?next=%2Fissues");
    await flushReact();
    await flushReact();
    const googleButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Sign in with Google",
    ) as HTMLButtonElement;
    expect(googleButton).not.toBeNull();
    await act(async () => {
      googleButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(signInGoogleMock).toHaveBeenCalledWith({
        successRedirectUrl: "/issues",
      }),
    );
    await act(() => root.unmount());
  });

  it("renders the Google callback error banner when google_error=callback_failed is present", async () => {
    const { root } = await mount("/auth?google_error=callback_failed");
    await flushReact();
    await flushReact();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Google sign-in failed");
    await act(() => root.unmount());
  });
});
