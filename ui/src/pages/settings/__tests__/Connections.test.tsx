// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const companyState = vi.hoisted(() => ({
  selectedCompany: { id: "c1", name: "Acme" },
  selectedCompanyId: "c1",
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
  dismissToast: vi.fn(),
  clearToasts: vi.fn(),
  toasts: [],
}));

const accessApiMock = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

const searchParamsState = vi.hoisted(() => {
  const initial = new URLSearchParams("");
  return {
    params: initial,
    setParams: vi.fn((updater: unknown, _options?: unknown) => {
      if (typeof updater === "function") {
        const next = new URLSearchParams(searchParamsState.params);
        (updater as (p: URLSearchParams) => URLSearchParams)(next);
        searchParamsState.params = next;
      }
    }),
    reset: () => {
      searchParamsState.params = new URLSearchParams("");
      searchParamsState.setParams.mockClear();
    },
  };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("@/api/access", () => ({
  accessApi: accessApiMock,
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useSearchParams: () => [searchParamsState.params, searchParamsState.setParams],
  };
});

import { Connections } from "../Connections";

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitFor(cond: () => void, attempts = 30) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      cond();
      return;
    } catch (e) {
      last = e;
      await flush();
    }
  }
  throw last;
}

function renderPage(children: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  });
  return { root, client };
}

const githubProvider = {
  id: "github",
  displayName: "GitHub",
  scopesDefault: ["repo"],
  scopesOffered: ["repo", "workflow"],
};

const slackProvider = {
  id: "slack",
  displayName: "Slack",
  scopesDefault: ["chat:write"],
  scopesOffered: ["chat:write", "channels:read"],
};

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(handler) as unknown as typeof fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fn;
  return fn;
}

describe("Connections page", () => {
  let container: HTMLDivElement;
  let assignMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    accessApiMock.listMembers.mockResolvedValue({
      members: [],
      access: { currentUserRole: "admin", canManageMembers: true, canInviteUsers: true, canApproveJoinRequests: true },
    });
    toastState.pushToast.mockClear();
    breadcrumbState.setBreadcrumbs.mockClear();
    searchParamsState.reset();
    originalLocation = window.location;
    assignMock = vi.fn();
    // jsdom's window.location is non-configurable; replace the whole object.
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      ...originalLocation,
      assign: assignMock,
      pathname: "/c1/company/settings/connections",
      search: "",
      hash: "",
    };
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: Location }).location = originalLocation;
  });

  it("renders provider tiles after the API resolves", async () => {
    mockFetch(async (url) => {
      if (url.includes("/oauth/providers")) {
        return new Response(JSON.stringify({ providers: [githubProvider, slackProvider] }), { status: 200 });
      }
      if (url.includes("/oauth/connections")) {
        return new Response(JSON.stringify({ connections: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    renderPage(<Connections />, container);
    await waitFor(() => {
      if (!container.textContent?.includes("GitHub")) throw new Error("no github");
      if (!container.textContent?.includes("Slack")) throw new Error("no slack");
    });
  });

  it("renders the empty state when no providers are configured", async () => {
    mockFetch(async (url) => {
      if (url.includes("/oauth/providers")) {
        return new Response(JSON.stringify({ providers: [] }), { status: 200 });
      }
      if (url.includes("/oauth/connections")) {
        return new Response(JSON.stringify({ connections: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    renderPage(<Connections />, container);
    await waitFor(
      () => {
        if (!document.body.querySelector('[data-testid="connections-empty-state"]')) {
          throw new Error("empty state not rendered");
        }
      },
      60,
    );
    expect(document.body.textContent).toMatch(/no providers configured/i);
  });

  it("redirects to authorizeUrl on Connect click", async () => {
    mockFetch(async (url, init) => {
      if (url.includes("/oauth/providers")) {
        return new Response(JSON.stringify({ providers: [githubProvider] }), { status: 200 });
      }
      if (url.includes("/oauth/connections") && (!init || init.method !== "DELETE")) {
        return new Response(JSON.stringify({ connections: [] }), { status: 200 });
      }
      if (url.includes("/oauth/connect/github") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ authorizeUrl: "https://provider.example/auth", state: "s" }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    renderPage(<Connections />, container);
    await waitFor(
      () => {
        if (!container.textContent?.includes("GitHub")) throw new Error("no github");
      },
      60,
    );
    const connectBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      /connect/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement | undefined;
    if (!connectBtn) throw new Error("no connect button");
    act(() => {
      connectBtn.click();
    });
    await waitFor(() => {
      if (!assignMock.mock.calls.some((c) => c[0] === "https://provider.example/auth")) {
        throw new Error("not assigned yet");
      }
    });
  });

  it("emits toast and clears query param when oauth_connected is present", async () => {
    searchParamsState.params = new URLSearchParams("?oauth_connected=GitHub");
    mockFetch(async (url) => {
      if (url.includes("/oauth/providers")) {
        return new Response(JSON.stringify({ providers: [githubProvider] }), { status: 200 });
      }
      if (url.includes("/oauth/connections")) {
        return new Response(JSON.stringify({ connections: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    renderPage(<Connections />, container);
    await waitFor(() => {
      if (toastState.pushToast.mock.calls.length === 0) throw new Error("not yet");
    });
    expect(toastState.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success", title: expect.stringMatching(/connected to github/i) }),
    );
    expect(searchParamsState.setParams).toHaveBeenCalled();
  });
});
