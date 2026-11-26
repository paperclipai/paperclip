// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsConnect } from "./AppsConnect";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchParams: new URLSearchParams(),
  params: {} as { appKey?: string },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
  useSearchParams: () => [mocks.searchParams, vi.fn()] as const,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/api/ai-connections", () => ({
  aiConnectionsApi: {
    list: vi.fn().mockResolvedValue({ connections: [], canManageConnections: true }),
    loginSetup: vi.fn(),
    startLocalLogin: vi.fn().mockResolvedValue({
      attemptId: "attempt-1",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=antigravity-state",
    }),
    checkLocalLogin: vi.fn().mockResolvedValue({
      status: "sign_in_required",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=antigravity-state",
    }),
    cancelLocalLogin: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([]),
    getAdapterAuthSignal: vi.fn().mockResolvedValue({ status: "missing" }),
  },
}));

vi.mock("@/api/environments", () => ({
  environmentsApi: {
    list: vi.fn().mockResolvedValue([]),
    capabilities: vi.fn().mockResolvedValue({ environments: {} }),
  },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    get: vi.fn().mockResolvedValue({}),
    getExperimental: vi.fn().mockResolvedValue({}),
    getGeneral: vi.fn().mockResolvedValue({ executionMode: "standard" }),
  },
}));

vi.mock("@/api/health", () => ({
  healthApi: {
    get: vi.fn().mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      localAiLoginSupported: false,
      hostedGoogleAiLoginSupported: true,
    }),
  },
}));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: vi.fn().mockResolvedValue({ apps: [] }),
    listConnections: vi.fn().mockResolvedValue({ connections: [] }),
  },
}));

vi.mock("@/components/new-agent/useSavedProviderKeys", () => ({
  useSavedProviderKeys: () => ({
    options: [],
    subscriptions: [],
    loading: false,
    storedLogin: { data: undefined, isPending: false, isError: false },
  }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = {};
  mocks.searchParams = new URLSearchParams();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function renderAppsConnect() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={client}>
        <AppsConnect />
      </QueryClientProvider>,
    );
  });
}

describe("AppsConnect Antigravity routing and branding", () => {
  it.each(["google", "google-ai"])("redirects legacy source=%s links to source=antigravity while preserving query params", async (legacySource) => {
    mocks.searchParams = new URLSearchParams({ source: legacySource, reconnect: "conn-123" });
    renderAppsConnect();
    await vi.waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith(
        "/apps/connect?source=antigravity&reconnect=conn-123",
        { replace: true },
      );
    });
  });

  it("renders Connect Antigravity with the Antigravity logo and hosted sign-in prompt for source=antigravity", async () => {
    mocks.searchParams = new URLSearchParams({ source: "antigravity" });
    renderAppsConnect();

    await vi.waitFor(() => {
      expect(host.querySelector("h2")?.textContent).toBe("Connect Antigravity");
    });
    await vi.waitFor(() => {
      expect(host.querySelector('input[aria-label="Antigravity redirect URL"]')).not.toBeNull();
    });
    expect(host.querySelector('img[src="/brands/apps/antigravity.svg"]')).not.toBeNull();
    expect(host.textContent).toContain("Sign in to Antigravity");
    expect(host.textContent).not.toContain("Connect Google");
  });
});
