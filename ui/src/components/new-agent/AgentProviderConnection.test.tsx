// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProviderConnection } from "./AgentProviderConnection";

const mocks = vi.hoisted(() => ({
  healthGet: vi.fn(),
  startLocalLogin: vi.fn(),
  checkLocalLogin: vi.fn(),
  submitLocalLoginCode: vi.fn(),
  cancelLocalLogin: vi.fn(),
  connectLocal: vi.fn(),
  listConnections: vi.fn(),
}));

vi.mock("@/api/health", () => ({ healthApi: { get: mocks.healthGet } }));
vi.mock("@/api/ai-connections", () => ({
  aiConnectionsApi: {
    startLocalLogin: mocks.startLocalLogin,
    checkLocalLogin: mocks.checkLocalLogin,
    submitLocalLoginCode: mocks.submitLocalLoginCode,
    cancelLocalLogin: mocks.cancelLocalLogin,
    connectLocal: mocks.connectLocal,
    list: mocks.listConnections,
    create: vi.fn(),
    loginResult: vi.fn(),
  },
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { getAdapterAuthSignal: vi.fn().mockResolvedValue({ status: "absent" }) },
}));
vi.mock("../onboarding/SavedProviderKeySelect", () => ({
  SavedProviderKeySelect: () => null,
  useSavedProviderKeys: () => ({
    options: [],
    subscriptions: [],
    loading: false,
    error: false,
    storedLogin: { data: undefined, isPending: false, isError: false, isFetching: false },
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.startLocalLogin.mockResolvedValue({ sessionId: "hosted-session-1", expiresAt: "2099-01-01T00:00:00Z" });
  mocks.checkLocalLogin.mockResolvedValue({
    status: "sign_in_required",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=hosted-ui-state",
  });
  mocks.submitLocalLoginCode.mockResolvedValue({ ok: true });
  mocks.cancelLocalLogin.mockResolvedValue({});
  mocks.connectLocal.mockResolvedValue({ connectionId: "conn-1", grantId: "grant-1" });
  mocks.listConnections.mockResolvedValue({ currentUserId: "u1", canManageConnections: true, connections: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function renderConnection(adapterType: "antigravity_runtime" | "claude_local" | "codex_local", localEnvironment: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const provider = adapterType === "antigravity_runtime" ? "google" : adapterType === "claude_local" ? "anthropic" : "openai";
  flushSync(() => {
    root.render(
      <QueryClientProvider client={client}>
        <AgentProviderConnection
          companyId="company-1"
          adapterType={adapterType}
          environmentId="sandbox-env-1"
          canLogin={false}
          localEnvironment={localEnvironment}
          onBack={() => {}}
          onConnected={() => {}}
          testConnection={async () => true}
          managedAccount={{
            intent: {
              provider,
              method: "subscription",
              name: "Test Account",
              ownership: "personal",
              agentIds: [],
              allAgents: true,
            },
            onComplete: () => {},
          }}
        />
      </QueryClientProvider>,
    );
  });
}

describe("AgentProviderConnection hosted Google sign-in gating", () => {
  it("enables hosted Google redirect sign-in for antigravity_runtime on non-local environments", async () => {
    mocks.healthGet.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      localAiLoginSupported: false,
      hostedGoogleAiLoginSupported: true,
    });
    renderConnection("antigravity_runtime", false);

    await vi.waitFor(() => expect(mocks.startLocalLogin).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(host.querySelector('input[aria-label="Antigravity redirect URL"]')).not.toBeNull());
    expect(host.querySelector('a[href="https://accounts.google.com/o/oauth2/v2/auth?state=hosted-ui-state"]')).not.toBeNull();
    expect(host.querySelector('img[src="/brands/apps/antigravity.svg"]')).not.toBeNull();
    expect(host.textContent).toContain("Antigravity");
    expect(host.textContent).toContain("Sign in to Antigravity");
    expect(host.textContent).toContain("127.0.0.1");

    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      const signInCta = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Sign in to Antigravity",
      ) as HTMLButtonElement | undefined;
      expect(signInCta).toBeDefined();
      expect(signInCta!.disabled).toBe(false);
      flushSync(() => signInCta!.click());
      expect(openSpy).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/v2/auth?state=hosted-ui-state",
        "_blank",
        "noreferrer,noopener",
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it("turns the primary footer button into Start sign in when Google sign-in fails or expires and retries on click", async () => {
    mocks.healthGet.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      localAiLoginSupported: false,
      hostedGoogleAiLoginSupported: true,
    });
    mocks.checkLocalLogin
      .mockResolvedValueOnce({
        status: "expired",
        error: "Google sign-in did not complete. Start sign-in again.",
      })
      .mockResolvedValueOnce({
        status: "sign_in_required",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=retried-state",
      });
    renderConnection("antigravity_runtime", false);

    await vi.waitFor(() => {
      expect(host.textContent).toContain("Google sign-in did not complete. Start sign-in again.");
    });
    const startSignInCta = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Start sign in",
    ) as HTMLButtonElement | undefined;
    expect(startSignInCta).toBeDefined();
    expect(startSignInCta!.disabled).toBe(false);
    // Redundant inline retry link is hidden when the footer owns Start sign in.
    expect(Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Start sign-in again",
    )).toBeUndefined();

    flushSync(() => startSignInCta!.click());
    await vi.waitFor(() => expect(mocks.startLocalLogin).toHaveBeenCalledTimes(2));
    expect(mocks.startLocalLogin).toHaveBeenLastCalledWith(
      "company-1",
      expect.objectContaining({ provider: "google", method: "subscription", restart: true }),
    );
    await vi.waitFor(() => {
      const signInCta = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Sign in to Antigravity",
      ) as HTMLButtonElement | undefined;
      expect(signInCta).toBeDefined();
      expect(signInCta!.disabled).toBe(false);
    });
  });

  it("switches the primary footer button back to Connect once Antigravity sign-in is ready", async () => {
    mocks.healthGet.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      localAiLoginSupported: false,
      hostedGoogleAiLoginSupported: true,
    });
    mocks.checkLocalLogin.mockResolvedValue({
      status: "ready",
      accountLabel: "dotta@paperclip.ing",
    });
    renderConnection("antigravity_runtime", false);

    await vi.waitFor(() => {
      const connectCta = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Connect",
      ) as HTMLButtonElement | undefined;
      expect(connectCta).toBeDefined();
      expect(connectCta!.disabled).toBe(false);
    });
  });

  it("still exposes the Antigravity redirect paste field when local login is also supported (remote private/trusted host)", async () => {
    mocks.healthGet.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      localAiLoginSupported: true,
      hostedGoogleAiLoginSupported: true,
    });
    renderConnection("antigravity_runtime", true);

    await vi.waitFor(() => expect(mocks.startLocalLogin).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(host.querySelector('input[aria-label="Antigravity redirect URL"]')).not.toBeNull());
    expect(host.textContent).toContain("another machine");
    expect(host.textContent).toContain("127.0.0.1");
  });

  it.each(["claude_local", "codex_local"] as const)("keeps local login disabled for %s on hosted instances", async (adapterType) => {
    mocks.healthGet.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      localAiLoginSupported: false,
      hostedGoogleAiLoginSupported: true,
    });
    renderConnection(adapterType, false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mocks.startLocalLogin).not.toHaveBeenCalled();
    expect(host.textContent).toContain("does not support browser sign-in");
  });
});
