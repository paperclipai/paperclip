// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GlobalKillSwitch } from "./GlobalKillSwitch";

const mockCompany = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => mockCompany.value,
}));
vi.mock("../../api/plans", () => ({
  plansApi: { engageKillSwitch: vi.fn(), releaseKillSwitch: vi.fn(), reactivateCompany: vi.fn() },
}));
vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <GlobalKillSwitch />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("GlobalKillSwitch label", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the engage label when the company is active", () => {
    mockCompany.value = {
      selectedCompanyId: "company-1",
      selectedCompany: { status: "active", pauseReason: null },
    };
    const root = render();
    expect(document.body.textContent).toContain("Kill switch");
    expect(document.body.textContent).not.toContain("Re-activate company");
    flushSync(() => root.unmount());
  });

  it("offers re-activate when the company is paused manually", () => {
    mockCompany.value = {
      selectedCompanyId: "company-1",
      selectedCompany: { status: "paused", pauseReason: "manual" },
    };
    const root = render();
    expect(document.body.textContent).toContain("Re-activate company");
    flushSync(() => root.unmount());
  });

  it("offers re-activate when the company is paused for any other reason (e.g. budget)", () => {
    mockCompany.value = {
      selectedCompanyId: "company-1",
      selectedCompany: { status: "paused", pauseReason: "budget" },
    };
    const root = render();
    expect(document.body.textContent).toContain("Re-activate company");
    flushSync(() => root.unmount());
  });
});
