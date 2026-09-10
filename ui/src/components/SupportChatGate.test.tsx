// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { SupportChatGate } from "./SupportChatGate";

const getSessionMock = vi.hoisted(() => vi.fn());
const fetchSupportChatSessionMock = vi.hoisted(() => vi.fn());
const mountSupportChatMock = vi.hoisted(() => vi.fn(async (_opts: unknown) => {}));
const hideSupportChatMock = vi.hoisted(() => vi.fn(async () => {}));
const updateSupportChatThemeMock = vi.hoisted(() => vi.fn(async (_theme: unknown) => {}));
const updateSupportChatCompanyMock = vi.hoisted(() => vi.fn(async (_tenant: unknown) => {}));
// The gate reads the selected company through useOptionalCompany; tests drive
// it with this stub instead of standing up the full CompanyProvider.
const companyContextMock = vi.hoisted(() => vi.fn((): unknown => null));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: () => getSessionMock() },
}));

vi.mock("@/api/supportChat", () => ({
  fetchSupportChatSession: (companyId: string | null) => fetchSupportChatSessionMock(companyId),
}));

vi.mock("@/lib/plain-chat", () => ({
  mountSupportChat: (opts: unknown) => mountSupportChatMock(opts),
  hideSupportChat: () => hideSupportChatMock(),
  updateSupportChatTheme: (theme: unknown) => updateSupportChatThemeMock(theme),
  updateSupportChatCompany: (tenant: unknown) => updateSupportChatCompanyMock(tenant),
}));

vi.mock("../context/CompanyContext", () => ({
  useOptionalCompany: () => companyContextMock(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const SESSION = {
  session: { id: "s-1", userId: "user-1" },
  user: { id: "user-1", email: "user@example.com", name: "User One", image: null },
  sentryDsn: null,
};

const CONFIG = {
  provider: "plain" as const,
  appId: "liveChatApp_TEST",
  devPreview: false,
  customer: {
    email: "user@example.com",
    emailHash: "a".repeat(64),
    fullName: "User One",
    externalId: "user-1",
  },
  company: null,
};

function companyBlock(id: string, name: string) {
  return { id, name, tenantId: `paperclip-company-${id}` };
}

describe("SupportChatGate", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    companyContextMock.mockImplementation(() => null);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderGate() {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SupportChatGate />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("mounts the widget with the server-provided config for a signed-in user", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    fetchSupportChatSessionMock.mockResolvedValue(CONFIG);

    await renderGate();

    expect(mountSupportChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "liveChatApp_TEST",
        customer: CONFIG.customer,
        identityKey: "user-1:verified",
      }),
    );
  });

  it("uses an anonymous identity key when the server attests no customer", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    fetchSupportChatSessionMock.mockResolvedValue({ ...CONFIG, customer: null });

    await renderGate();

    expect(mountSupportChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: null, identityKey: "user-1:anonymous" }),
    );
  });

  it("never asks for support chat config while signed out", async () => {
    getSessionMock.mockRejectedValue(new Error("Unauthorized"));

    await renderGate();

    expect(fetchSupportChatSessionMock).not.toHaveBeenCalled();
    expect(mountSupportChatMock).not.toHaveBeenCalled();
  });

  it("does not mount when the server reports support chat disabled", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    fetchSupportChatSessionMock.mockResolvedValue(null);

    await renderGate();

    expect(mountSupportChatMock).not.toHaveBeenCalled();
  });

  it("asks the server for the selected company and mounts with its tenant context", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    companyContextMock.mockImplementation(() => ({ selectedCompanyId: "c-1" }));
    fetchSupportChatSessionMock.mockResolvedValue({ ...CONFIG, company: companyBlock("c-1", "Co One") });

    await renderGate();

    expect(fetchSupportChatSessionMock).toHaveBeenCalledWith("c-1");
    expect(mountSupportChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "paperclip-company-c-1",
        identityKey: "user-1:verified",
      }),
    );
  });

  it("hides stale context while switching companies and re-shows with the new tenant", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    companyContextMock.mockImplementation(() => ({ selectedCompanyId: "c-1" }));
    fetchSupportChatSessionMock.mockResolvedValue({ ...CONFIG, company: companyBlock("c-1", "Co One") });

    const root = await renderGate();
    expect(mountSupportChatMock).toHaveBeenCalledTimes(1);
    hideSupportChatMock.mockClear();
    updateSupportChatCompanyMock.mockClear();

    companyContextMock.mockImplementation(() => ({ selectedCompanyId: "c-2" }));
    fetchSupportChatSessionMock.mockResolvedValue({ ...CONFIG, company: companyBlock("c-2", "Co Two") });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SupportChatGate />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(fetchSupportChatSessionMock).toHaveBeenLastCalledWith("c-2");
    expect(mountSupportChatMock).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: "paperclip-company-c-2" }));
    expect(hideSupportChatMock).toHaveBeenCalled();
  });

  it("keeps stale chat hidden when the new company session request fails", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    companyContextMock.mockImplementation(() => ({ selectedCompanyId: "c-1" }));
    fetchSupportChatSessionMock.mockResolvedValue({ ...CONFIG, company: companyBlock("c-1", "Co One") });
    const root = await renderGate();
    mountSupportChatMock.mockClear();
    hideSupportChatMock.mockClear();
    let rejectRequest!: (err: Error) => void;
    fetchSupportChatSessionMock.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    companyContextMock.mockImplementation(() => ({ selectedCompanyId: "c-2" }));
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><ThemeProvider><SupportChatGate /></ThemeProvider></QueryClientProvider>);
    });
    await flushReact();
    expect(hideSupportChatMock).toHaveBeenCalled();
    expect(mountSupportChatMock).not.toHaveBeenCalled();
    rejectRequest(new Error("session unavailable"));
    await flushReact();
    await flushReact();
    expect(mountSupportChatMock).not.toHaveBeenCalled();
  });

  it("passes no company to the server when rendered without a company provider", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    fetchSupportChatSessionMock.mockResolvedValue(CONFIG);

    await renderGate();

    expect(fetchSupportChatSessionMock).toHaveBeenCalledWith(null);
    expect(mountSupportChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: null }),
    );
  });

  it("hides the launcher when the session goes away", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    fetchSupportChatSessionMock.mockResolvedValue(CONFIG);

    await renderGate();
    expect(mountSupportChatMock).toHaveBeenCalled();
    hideSupportChatMock.mockClear();

    // Sign-out drops the account-scoped caches; the session query returns
    // nothing on its next pass.
    getSessionMock.mockRejectedValue(new Error("Unauthorized"));
    await act(async () => {
      await queryClient.resetQueries();
    });
    await flushReact();

    expect(hideSupportChatMock).toHaveBeenCalled();
  });
});
