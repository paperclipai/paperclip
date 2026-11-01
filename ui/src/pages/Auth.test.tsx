// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { AuthPage } from "./Auth";
import { CliAuthPage } from "./CliAuth";
import { ApiError } from "../api/client";

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
    themePreference: "dark",
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
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
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
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: queryKeys.health });

    await act(async () => {
      root.unmount();
    });
  });
});

describe("CliAuthPage rate-limit recovery", () => {
  const challengeId = "00000000-0000-4000-8000-000000000429";
  const challengeToken = "synthetic-cli-approval-fixture-token";
  const challengePath = `/api/cli-auth/challenges/${challengeId}?token=${challengeToken}`;
  const challengeQueryKey = ["cli-auth-challenge", challengeId, challengeToken];
  const fetchCli = vi.fn<typeof fetch>();
  let cliContainer: HTMLDivElement;
  let cliRoot: ReturnType<typeof createRoot> | undefined;
  let cliClient: QueryClient | undefined;

  function response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function pending(expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()) {
    return { id: challengeId, status: "pending", command: "paperclipai auth login", clientName: "paperclipai cli",
      requestedAccess: "board", requestedCompanyId: null, requestedCompanyName: null, approvedAt: null,
      cancelledAt: null, expiresAt, approvedByUser: null, requiresSignIn: false, canApprove: true, currentUserId: "operator" };
  }

  async function advance(milliseconds: number) {
    await reactAct(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
    await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  async function mountCli() {
    cliClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    cliRoot = createRoot(cliContainer);
    await reactAct(async () => {
      cliRoot!.render(<MemoryRouter initialEntries={[`/cli-auth/${challengeId}?token=${challengeToken}`]}>
        <QueryClientProvider client={cliClient!}><Routes>
          <Route path="/cli-auth/:id" element={<CliAuthPage />} />
        </Routes></QueryClientProvider>
      </MemoryRouter>);
    });
    await advance(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T20:00:00Z"));
    fetchCli.mockReset();
    vi.stubGlobal("fetch", fetchCli);
    getSessionMock.mockResolvedValue({ user: { id: "operator" }, session: { id: "operator-session" } });
    cliContainer = document.createElement("div");
    document.body.appendChild(cliContainer);
  });

  afterEach(async () => {
    await reactAct(async () => { cliRoot?.unmount(); });
    cliClient?.clear();
    cliRoot = undefined;
    cliClient = undefined;
    cliContainer.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("waits for the real API retry hint and recovers approval without a reload or automatic mutation", async () => {
    fetchCli.mockResolvedValueOnce(response({ error: "Too many CLI auth requests", details: { retryAfterSeconds: 2 } }, 429))
      .mockResolvedValueOnce(response(pending()));
    await mountCli();
    expect(fetchCli).toHaveBeenCalledTimes(1);
    expect(cliContainer.textContent).toContain("Retrying shortly");
    expect(cliContainer.textContent).not.toContain("CLI auth challenge unavailable");
    await advance(1999);
    expect(fetchCli).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchCli).toHaveBeenCalledTimes(2);
    expect(cliClient!.getQueryState(challengeQueryKey)).toMatchObject({ status: "success", fetchStatus: "idle", data: { status: "pending" } });
    await advance(1);
    expect(cliContainer.textContent).toContain("Approve Paperclip CLI access");
    expect(fetchCli.mock.calls.map(([url, init]) => [String(url), init?.method]))
      .toEqual([[challengePath, "GET"], [challengePath, "GET"]]);
  });

  it.each([400, 401, 403, 404, 410, 500])("does not retry an ordinary approval GET failure with HTTP%s", async status => {
    fetchCli.mockImplementation(async () => response({ error: "Challenge unavailable" }, status));
    await mountCli();
    expect(cliContainer.textContent).toContain("CLI auth challenge unavailable");
    expect(cliClient!.getQueryState(challengeQueryKey)?.error).toBeInstanceOf(ApiError);
    await advance(10 * 60_000);
    expect(fetchCli).toHaveBeenCalledTimes(1);
  });

  it("uses a nonzero fallback and stops after three retries when the actual challenge expiry is unknown", async () => {
    fetchCli.mockImplementation(async () => response({ error: "Too many CLI auth requests" }, 429));
    await mountCli();
    expect(cliClient!.getQueryData(challengeQueryKey)).toBeUndefined();
    await advance(59_999);
    expect(fetchCli).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchCli).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(fetchCli).toHaveBeenCalledTimes(3);
    await advance(60_000);
    expect(fetchCli).toHaveBeenCalledTimes(4);
    expect(cliClient!.getQueryState(challengeQueryKey)).toMatchObject({ status: "error", fetchStatus: "idle", error: { status: 429 } });
    await advance(1);
    expect(cliContainer.textContent).toContain("CLI auth challenge unavailable");
    await advance(10 * 60_000);
    expect(fetchCli).toHaveBeenCalledTimes(4);
  });

  it("does not schedule a hinted retry beyond the actual expiry from an earlier successful read", async () => {
    fetchCli.mockResolvedValueOnce(response(pending(new Date(Date.now() + 1500).toISOString())))
      .mockImplementation(async () => response({ error: "Too many CLI auth requests", details: { retryAfterSeconds: 2 } }, 429));
    await mountCli();
    expect(cliContainer.textContent).toContain("Approve Paperclip CLI access");
    await reactAct(async () => { void cliClient!.invalidateQueries({ queryKey: challengeQueryKey }); });
    await advance(0);
    expect(fetchCli).toHaveBeenCalledTimes(2);
    expect(cliContainer.textContent).toContain("CLI auth challenge unavailable");
    await advance(10 * 60_000);
    expect(fetchCli).toHaveBeenCalledTimes(2);
  });

  it("does not shorten a hint that falls outside the finite page retry window", async () => {
    fetchCli.mockImplementation(async () => response({ error: "Too many CLI auth requests", details: { retryAfterSeconds: 600 } }, 429));
    await mountCli();
    expect(cliContainer.textContent).toContain("CLI auth challenge unavailable");
    await advance(20 * 60_000);
    expect(fetchCli).toHaveBeenCalledTimes(1);
  });

  it("retries only the rate-limited read after one operator approval, without resubmitting it", async () => {
    let reads = 0;
    fetchCli.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return response({ approved: true, status: "approved" });
      reads += 1;
      if (reads === 2) return response({ error: "Too many CLI auth requests", details: { retryAfterSeconds: 2 } }, 429);
      return response({ ...pending(), status: reads > 2 ? "approved" : "pending" });
    });
    await mountCli();
    const approve = [...cliContainer.querySelectorAll("button")].find(button => button.textContent === "Approve CLI access");
    expect(approve).toBeDefined();
    await reactAct(async () => { approve!.click(); });
    await advance(0);
    expect(fetchCli.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(reads).toBe(2);
    await advance(2000);
    expect(reads).toBe(3);
    expect(cliClient!.getQueryState(challengeQueryKey)).toMatchObject({ status: "success", fetchStatus: "idle", data: { status: "approved" } });
    await advance(1);
    expect(cliContainer.textContent).toContain("CLI access approved");
    expect(fetchCli.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url)))
      .toEqual([`/api/cli-auth/challenges/${challengeId}/approve`]);
  });
});
