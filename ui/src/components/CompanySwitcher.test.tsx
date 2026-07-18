// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySwitcher } from "./CompanySwitcher";

const navigateMock = vi.hoisted(() => vi.fn());
const getCurrentBoardAccessMock = vi.hoisted(() => vi.fn());
const setSelectedCompanyIdMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  // The "Manage Companies" / "Company Settings" items render a Link; stub it.
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Acme", status: "active" }],
    selectedCompany: { id: "company-1", name: "Acme", status: "active" },
    setSelectedCompanyId: setSelectedCompanyIdMock,
  }),
}));

vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: () => getCurrentBoardAccessMock() },
}));

// Render the dropdown primitives plainly so menu items are visible/clickable in
// jsdom without Radix portals. DropdownMenuItem forwards onSelect to a click.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
    onSelect,
  }: {
    children: ReactNode;
    onClick?: () => void;
    onSelect?: (e: { preventDefault: () => void }) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onClick?.();
        onSelect?.({ preventDefault: () => {} });
      }}
    >
      {children}
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderSwitcher(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { root, queryClient };
}

describe("CompanySwitcher — standing badges", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderWithStandings(companyStandings: Record<string, unknown>) {
    getCurrentBoardAccessMock.mockResolvedValue({ capabilities: { companyStandings } });
    const { root, queryClient } = renderSwitcher(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySwitcher />
        </QueryClientProvider>,
      );
    });
    await flushReact(); // resolve the board-access query
    return root;
  }

  it("shows a Blocked badge on companies with blocked standing", async () => {
    const root = await renderWithStandings({
      "company-1": { status: "blocked", reason: "subscription_lapsed", message: "Lapsed." },
    });
    const badge = container.querySelector('[data-testid="company-standing-badge-company-1"]');
    expect(badge?.textContent).toBe("Blocked");
    expect(badge?.getAttribute("data-standing")).toBe("blocked");
    await act(async () => root.unmount());
  });

  it("shows an Attention badge on companies with grace standing", async () => {
    const root = await renderWithStandings({
      "company-1": { status: "grace", reason: "payment_failed", message: "Failed." },
    });
    const badge = container.querySelector('[data-testid="company-standing-badge-company-1"]');
    expect(badge?.textContent).toBe("Attention");
    expect(badge?.getAttribute("data-standing")).toBe("grace");
    await act(async () => root.unmount());
  });

  it("shows no badge for active or unknown standing", async () => {
    const root = await renderWithStandings({ "company-1": { status: "active" } });
    expect(container.querySelector('[data-testid="company-standing-badge-company-1"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
