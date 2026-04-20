// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteLandingPage } from "./InviteLanding";

const getInviteMock = vi.hoisted(() => vi.fn());
const acceptInviteMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const signInEmailMock = vi.hoisted(() => vi.fn());
const signUpEmailMock = vi.hoisted(() => vi.fn());
const healthGetMock = vi.hoisted(() => vi.fn());
const listCompaniesMock = vi.hoisted(() => vi.fn());
const setSelectedCompanyIdMock = vi.hoisted(() => vi.fn());

vi.mock("../api/access", () => ({
  accessApi: {
    getInvite: (token: string) => getInviteMock(token),
    acceptInvite: (token: string, input: unknown) => acceptInviteMock(token, input),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInEmail: (input: unknown) => signInEmailMock(input),
    signUpEmail: (input: unknown) => signUpEmailMock(input),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("InviteLandingPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
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

    getInviteMock.mockResolvedValue({
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
    });
    acceptInviteMock.mockReset();
    healthGetMock.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
    });
    listCompaniesMock.mockResolvedValue([]);
    getSessionMock.mockResolvedValue(null);
    signInEmailMock.mockResolvedValue(undefined);
    signUpEmailMock.mockResolvedValue(undefined);
    setSelectedCompanyIdMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("defaults invite auth to account creation and guides existing users back to sign in", async () => {
    signUpEmailMock.mockRejectedValue(
      Object.assign(new Error("User already exists. Use another email."), {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        status: 422,
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

    expect(container.textContent).toContain("You've been invited to join Paperclip");
    expect(container.textContent).toContain("Join Acme Robotics");
    expect(container.textContent).toContain("Create account");
    expect(container.textContent).toContain("I already have an account");
    expect(container.textContent).toContain("Message from inviter");
    expect(container.querySelector('[data-testid="invite-inline-auth"]')).not.toBeNull();
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBe("pcp_invite_test");
    const inviteLogo = container.querySelector('img[alt="Acme Robotics logo"]');
    expect(inviteLogo).not.toBeNull();
    expect(inviteLogo?.className).toContain("object-contain");
    expect(container.querySelector('input[name="name"]')).not.toBeNull();

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement | null;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");

    await act(async () => {
      inputValueSetter!.call(nameInput, "Jane Example");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "supersecret");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const authForm = container.querySelector('[data-testid="invite-inline-auth"]') as HTMLFormElement | null;
    expect(authForm).not.toBeNull();

    await act(async () => {
      authForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(signUpEmailMock).toHaveBeenCalledWith({
      name: "Jane Example",
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(container.textContent).toContain("An account already exists for jane@example.com. Sign in below to continue with this invite.");
    expect(container.querySelector('input[name="name"]')).toBeNull();
    expect(container.textContent).toContain("Sign in to continue");
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBe("pcp_invite_test");

    await act(async () => {
      root.unmount();
    });
  });

  it("turns invalid sign-in responses into a clear invite-specific message", async () => {
    signInEmailMock.mockRejectedValue(
      Object.assign(new Error("Invalid email or password"), {
        code: "INVALID_EMAIL_OR_PASSWORD",
        status: 401,
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

    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");

    const existingAccountButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "I already have an account",
    );
    expect(existingAccountButton).not.toBeNull();

    await act(async () => {
      existingAccountButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    await act(async () => {
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "wrongpass");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const authForm = container.querySelector('[data-testid="invite-inline-auth"]') as HTMLFormElement | null;
    expect(authForm).not.toBeNull();

    await act(async () => {
      authForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "wrongpass",
    });
    expect(container.textContent).toContain(
      "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("auto-accepts the invite after account creation and redirects into the company", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: "company-1",
      requestType: "human",
      status: "approved",
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

    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement | null;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    await act(async () => {
      inputValueSetter!.call(nameInput, "Jane Example");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "supersecret");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const authForm = container.querySelector('[data-testid="invite-inline-auth"]') as HTMLFormElement | null;
    expect(authForm).not.toBeNull();

    await act(async () => {
      authForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();
    await flushReact();
    await flushReact();

    expect(signUpEmailMock).toHaveBeenCalledWith({
      name: "Jane Example",
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test", { requestType: "human" });
    expect(setSelectedCompanyIdMock).toHaveBeenCalledWith("company-1", { source: "manual" });
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the pending approval page with the company icon and linked access instructions", async () => {
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
    await flushReact();

    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test", { requestType: "human" });
    expect(container.textContent).toContain("Request to join Acme Robotics");
    expect(container.textContent).toContain("A company admin must approve your request to join.");
    expect(container.textContent).toContain(
      "Ask them to visit Company Settings → Access to approve your request.",
    );
    expect(container.querySelector('img[alt="Acme Robotics logo"]')).not.toBeNull();
    expect(container.textContent).not.toContain("http://localhost/company/settings/access");

    const approvalLinks = Array.from(container.querySelectorAll("a")).filter(
      (link) => link.textContent === "Company Settings → Access",
    );
    expect(approvalLinks).toHaveLength(2);
    const expectedApprovalUrl = `${window.location.origin}/company/settings/access`;
    for (const link of approvalLinks) {
      expect(link.getAttribute("href")).toBe(expectedApprovalUrl);
    }

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the waiting-for-approval state on refresh for an accepted invite", async () => {
    getInviteMock.mockResolvedValue({
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
      joinRequestStatus: "pending_approval",
      joinRequestType: "human",
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

    expect(acceptInviteMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="invite-pending-approval"]')).not.toBeNull();
    expect(container.textContent).toContain("Your request is still awaiting approval.");
    expect(container.textContent).toContain(
      "Ask them to visit Company Settings → Access to approve your request.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("redirects straight to the company after sign-in when the user already has access", async () => {
    getSessionMock.mockResolvedValueOnce(null);
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

    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");

    const existingAccountButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "I already have an account",
    );
    expect(existingAccountButton).not.toBeNull();

    await act(async () => {
      existingAccountButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    await act(async () => {
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "supersecret");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const authForm = container.querySelector('[data-testid="invite-inline-auth"]') as HTMLFormElement | null;
    expect(authForm).not.toBeNull();

    await act(async () => {
      authForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(acceptInviteMock).not.toHaveBeenCalled();
    expect(setSelectedCompanyIdMock).toHaveBeenCalledWith("company-1", { source: "manual" });
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to the generated company icon when the invite logo fails to load", async () => {
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

    const logo = container.querySelector('img[alt="Acme Robotics logo"]') as HTMLImageElement | null;
    expect(logo).not.toBeNull();

    await act(async () => {
      logo?.dispatchEvent(new Event("error"));
    });
    await flushReact();

    expect(container.querySelector('img[alt="Acme Robotics logo"]')).toBeNull();
    expect(container.querySelector('img[aria-hidden="true"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("waits for the membership check before showing invite acceptance to signed-in users", async () => {
    let resolveCompanies: ((value: Array<{ id: string; name: string }>) => void) | null = null;
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: "company-1",
      requestType: "human",
      status: "pending_approval",
    });
    listCompaniesMock.mockImplementation(
      () =>
        new Promise<Array<{ id: string; name: string }>>((resolve) => {
          resolveCompanies = resolve;
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

    expect(container.textContent).toContain("Checking your access...");
    expect(container.textContent).not.toContain("Accept company invite");
    expect(acceptInviteMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveCompanies?.([]);
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test", { requestType: "human" });
    expect(container.textContent).toContain("Request to join Acme Robotics");

    await act(async () => {
      root.unmount();
    });
  });
});
