// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAccessGate } from "./CloudAccessGate";
import { CompanyProvider } from "@/context/CompanyContext";

const getSessionMock = vi.hoisted(() => vi.fn());
const getCurrentBoardAccessMock = vi.hoisted(() => vi.fn());
const healthGetMock = vi.hoisted(() => vi.fn());

vi.mock("../api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: () => getCurrentBoardAccessMock(),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
  },
}));

vi.mock("../api/health", () => ({
  healthApi: {
    get: () => healthGetMock(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
}

describe("CloudAccessGate — NoBoardAccessPage QA", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    healthGetMock.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
    });
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    getCurrentBoardAccessMock.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("(Case 3) shows amber recovery box when a pending invite token exists in localStorage", async () => {
    localStorage.setItem("paperclip:pending-invite-token", "invite-token-123");

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root: ReturnType<typeof createRoot>;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={qc}>
          <CompanyProvider>
            <MemoryRouter>
              <CloudAccessGate />
            </MemoryRouter>
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No company access");
    expect(container.textContent).toContain("Pending invite found");
    expect(container.textContent).toContain("Open invite link");
    const link = container.querySelector('a[href="/invite/invite-token-123"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("Open invite link");

    await act(async () => { root!.unmount(); });
  });

  it("(Case 4) shows normal message without recovery box when no invite token exists", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root: ReturnType<typeof createRoot>;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={qc}>
          <CompanyProvider>
            <MemoryRouter>
              <CloudAccessGate />
            </MemoryRouter>
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No company access");
    expect(container.textContent).not.toContain("Pending invite found");
    expect(container.textContent).not.toContain("Open invite link");
    expect(container.textContent).toContain("Use a company invite or sign in with an account that already belongs to this org.");

    await act(async () => { root!.unmount(); });
  });
});
