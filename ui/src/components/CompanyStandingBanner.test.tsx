// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyStandingBanner } from "./CompanyStandingBanner";

const getCurrentBoardAccessMock = vi.hoisted(() => vi.fn());
const useCompanyMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: () => getCurrentBoardAccessMock() },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => useCompanyMock(),
}));

// Same module-level flag CompanySwitcher.test.tsx sets (:79).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function boardAccess(companyStandings: Record<string, unknown>) {
  return {
    user: null,
    userId: "user-1",
    isInstanceAdmin: false,
    companyIds: Object.keys(companyStandings),
    source: "session",
    keyId: null,
    capabilities: { companyStandings },
  };
}

describe("CompanyStandingBanner", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useCompanyMock.mockReturnValue({ selectedCompanyId: "company-1" });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyStandingBanner />
        </QueryClientProvider>,
      );
    });
    // Let the query resolve (microtasks + a macrotask, like the
    // flushReact helper in CompanySwitcher.test.tsx:82-87).
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  it("renders nothing when the selected company is active", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({ "company-1": { status: "active" } }),
    );
    await render();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when standings are missing (fail-safe)", async () => {
    getCurrentBoardAccessMock.mockResolvedValue({
      user: null,
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });
    await render();
    expect(container.textContent).toBe("");
  });

  it("renders a warning with action link for grace", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": {
          status: "grace",
          reason: "payment_failed",
          message: "Your last payment failed.",
          actionUrl: "/billing",
        },
      }),
    );
    await render();
    const banner = container.querySelector('[data-testid="company-standing-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-standing")).toBe("grace");
    expect(banner!.textContent).toContain("Your last payment failed.");
    const link = banner!.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/billing");
  });

  it("renders an error banner with action link for blocked", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": {
          status: "blocked",
          reason: "subscription_lapsed",
          message: "Your subscription has lapsed. New agent runs are paused.",
          actionUrl: "/billing",
        },
      }),
    );
    await render();
    const banner = container.querySelector('[data-testid="company-standing-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-standing")).toBe("blocked");
    expect(banner!.textContent).toContain("New agent runs are paused");
    expect(banner!.querySelector("a")?.getAttribute("href")).toBe("/billing");
  });

  it("renders nothing for a different selected company", async () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: "company-2" });
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": { status: "blocked", reason: "x", message: "Blocked." },
      }),
    );
    await render();
    expect(container.textContent).toBe("");
  });

  it("renders relative actionUrl without target or rel attributes", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": {
          status: "grace",
          reason: "payment_failed",
          message: "Payment issue.",
          actionUrl: "/company/settings/billing",
        },
      }),
    );
    await render();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/company/settings/billing");
    expect(link?.getAttribute("target")).toBeNull();
    expect(link?.getAttribute("rel")).toBeNull();
  });

  it("renders absolute https actionUrl with target=_blank and rel=noreferrer", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": {
          status: "blocked",
          reason: "subscription_lapsed",
          message: "Subscription lapsed.",
          actionUrl: "https://example.com/billing",
        },
      }),
    );
    await render();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/billing");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("renders absolute http actionUrl with target=_blank and rel=noreferrer", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": {
          status: "grace",
          reason: "payment_failed",
          message: "Payment issue.",
          actionUrl: "http://example.com/resolve",
        },
      }),
    );
    await render();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("http://example.com/resolve");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });
});
