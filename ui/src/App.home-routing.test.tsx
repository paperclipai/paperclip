// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const streamlinedUiState = vi.hoisted(() => ({ enabled: true, loaded: true }));

vi.mock("./hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => streamlinedUiState,
}));

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papHomeRoutingPatched?: boolean;
  };
  if (!sheetProto.__papHomeRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap16302-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papHomeRoutingPatched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries) and
// owns the "No company matches prefix" NotFound. For routing we only need it to
// resolve the :companyPrefix segment and render its nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/Layout.production", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

// Rendered by <App> outside <Routes> and needs DialogProvider; irrelevant here.
// These routing tests render App without a QueryClientProvider.
vi.mock("./components/PageLoadTracker", () => ({ PageLoadTracker: () => null }));

vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Cloud access is unrelated to the route-table regression. Let it fall through
// synchronously so this test does not poll its query transitions.
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

const homeState = vi.hoisted(() => ({
  value: { path: "/dashboard", loaded: true, error: null as unknown, retry: () => {} },
}));
vi.mock("./hooks/useCompanyHomePath", () => ({ useCompanyHomePath: () => homeState.value }));

vi.mock("./pages/Dashboard", () => ({ Dashboard: () => <div>CLASSIC_DASHBOARD</div> }));

const COMPANY = { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" };
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({ companies: [COMPANY], selectedCompanyId: COMPANY.id, selectedCompany: COMPANY, loading: false }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("App root redirect", () => {
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

  it("shows a settings read failure with Retry instead of loading forever", async () => {
    const retry = vi.fn();
    homeState.value = { path: "/dashboard", loaded: false, error: new Error("Server error"), retry };
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>,
      );
    });
    const button = await vi.waitFor(() => {
      const found = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("Retry"));
      expect(found).toBeTruthy();
      return found!;
    });
    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(container.textContent).not.toContain("CLASSIC_DASHBOARD");
    flushSync(() => button.click());
    expect(retry).toHaveBeenCalledOnce();
    flushSync(() => root.unmount());
  });
});
