// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteLandingPage } from "./InviteLanding";
import { queryKeys } from "../lib/queryKeys";

const getInviteMock = vi.hoisted(() => vi.fn());
const acceptInviteMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const healthGetMock = vi.hoisted(() => vi.fn());
const listCompaniesMock = vi.hoisted(() => vi.fn());
const setSelectedCompanyIdMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("../api/access", () => ({
  accessApi: {
    getInvite: (token: string) => getInviteMock(token),
    acceptInvite: (token: string, input: unknown) => acceptInviteMock(token, input),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInEmail: vi.fn(),
    signUpEmail: vi.fn(),
  },
}));

vi.mock("../api/health", () => ({
  healthApi: {
    get: () => healthGetMock(),
  },
}));

vi.mock("../api/companies", () => ({
  companiesApi: {
    list: () => listCompaniesMock(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: setSelectedCompanyIdMock,
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => ({ token: "pcp_invite_test" }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function createInviteFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    companyId: "company-1",
    companyName: "Acme Robotics",
    companyLogoUrl: "/api/invites/pcp_invite_test/logo",
    companyBrandColor: "#114488",
    inviteType: "company_join",
    allowedJoinTypes: "both",
    humanRole: "operator",
    expiresAt: "2027-03-07T00:10:00.000Z",
    inviteMessage: "Welcome aboard.",
    ...overrides,
  };
}

describe("InviteLandingPage render", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);

    // Mock canvas for CompanyPatternIcon
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({
        fillStyle: "",
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: vi.fn(() => "data:image/png;base64,stub"),
    });

    getInviteMock.mockResolvedValue(createInviteFixture());
    acceptInviteMock.mockReset();
    healthGetMock.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
    });
    listCompaniesMock.mockResolvedValue([]);
    getSessionMock.mockResolvedValue(null);
    setSelectedCompanyIdMock.mockReset();
    navigateMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders loading state while fetching invite", async () => {
    let resolveInvite: (value: unknown) => void = () => {};
    getInviteMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvite = resolve;
        }),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Loading invite...");
    expect(container.textContent).not.toContain("Join Acme Robotics");

    await act(async () => {
      resolveInvite(createInviteFixture());
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Join Acme Robotics");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders error state for expired or revoked invite", async () => {
    getInviteMock.mockRejectedValue(new Error("Invite not found"));

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('[data-testid="invite-error"]')).not.toBeNull();
    expect(container.textContent).toContain("Invite not available");
    expect(container.textContent).toContain("This invite may be expired, revoked, or already used.");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the main invite form with company details and auth section", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("You've been invited to join Paperclip");
    expect(container.textContent).toContain("Join Acme Robotics");
    expect(container.textContent).toContain("Company");
    expect(container.textContent).toContain("Acme Robotics");
    expect(container.textContent).toContain("Invited by");
    expect(container.textContent).toContain("Requested access");
    expect(container.textContent).toContain("Operator");
    expect(container.textContent).toContain("Invite expires");
    expect(container.textContent).toContain("Message from inviter");
    expect(container.textContent).toContain("Welcome aboard.");
    expect(container.querySelector('img[alt="Acme Robotics logo"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="invite-inline-auth"]')).not.toBeNull();
    expect(container.textContent).toContain("Create your account");
    expect(container.textContent).toContain("Create account");
    expect(container.textContent).toContain("I already have an account");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders agent form for agent-only invites", async () => {
    getInviteMock.mockResolvedValue(
      createInviteFixture({
        allowedJoinTypes: "agent",
        inviteType: "company_join",
      }),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Submit agent details");
    expect(container.textContent).toContain("Agent name");
    expect(container.textContent).toContain("Adapter type");
    expect(container.textContent).toContain("Capabilities");
    expect(container.querySelector('[data-testid="invite-inline-auth"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders bootstrap complete state after accepting bootstrap invite", async () => {
    getInviteMock.mockResolvedValue(
      createInviteFixture({
        inviteType: "bootstrap_ceo",
        allowedJoinTypes: "human",
      }),
    );
    acceptInviteMock.mockResolvedValue({
      bootstrapAccepted: true,
      companyId: "company-1",
    });
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();
    await flushReact();

    // Find and click the accept button for bootstrap invite
    const acceptButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Accept invite",
    );
    expect(acceptButton).not.toBeNull();

    await act(async () => {
      acceptButton?.click();
    });
    await flushReact();
    await flushReact();

    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test", { requestType: "human" });
    expect(container.textContent).toContain("Bootstrap complete");
    expect(container.textContent).toContain("Open board");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders join success state after approved join", async () => {
    getInviteMock.mockResolvedValue(createInviteFixture());
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: "company-1",
      requestType: "human",
      status: "approved",
    });
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("You joined the company");
    expect(container.textContent).toContain("Open board");
    expect(container.querySelector('img[alt="Acme Robotics logo"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders pending approval state with company branding", async () => {
    getInviteMock.mockResolvedValue(
      createInviteFixture({
        joinRequestStatus: "pending_approval",
        joinRequestType: "human",
      }),
    );
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: "company-1",
      requestType: "human",
      status: "pending_approval",
    });
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.querySelector('[data-testid="invite-pending-approval"]')).not.toBeNull();
    expect(container.textContent).toContain("Request to join Acme Robotics");
    expect(container.textContent).toContain("A company admin must approve your request to join.");
    expect(container.textContent).toContain("Company Settings → Members");
    expect(container.querySelector('img[alt="Acme Robotics logo"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders already-member state for signed-in users with company access", async () => {
    getInviteMock.mockResolvedValue(createInviteFixture());
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    listCompaniesMock.mockResolvedValue([{ id: "company-1", name: "Acme Robotics" }]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Already in this company");
    expect(container.textContent).toContain("This account already belongs to Acme Robotics.");
    expect(container.textContent).toContain("Open company");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders rejected join request state", async () => {
    getInviteMock.mockResolvedValue(
      createInviteFixture({
        joinRequestStatus: "rejected",
        joinRequestType: "human",
      }),
    );
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/invite/:token" element={<InviteLandingPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('[data-testid="invite-error"]')).not.toBeNull();
    expect(container.textContent).toContain("Invite not available");
    expect(container.textContent).toContain("This join request was not approved.");

    await act(async () => {
      root.unmount();
    });
  });
});
