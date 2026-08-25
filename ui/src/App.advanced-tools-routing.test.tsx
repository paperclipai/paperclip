// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom rejects a custom-property marker emitted by Sandpack's transitive
// styles. The advanced-tools route does not exercise Sandpack, so keep that
// eager import from obscuring the routing assertion.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __pap17809Patched?: boolean;
  };
  if (!sheetProto.__pap17809Patched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap17809-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__pap17809Patched = true;
  }
});

vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

vi.mock("./components/AppsExperimentalGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { AppsExperimentalGate: () => <Outlet /> };
});

// Treat both EE host features as enabled. If a static gated route shadows the
// dynamic route, this test still enters it and observes the missing :tab param.
vi.mock("./components/HostFeatureGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { HostFeatureGate: () => <Outlet /> };
});

vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Keep the real App route tree and real router params. The sentinel mirrors the
// tab choice that ToolsAccess makes: an absent param falls back to run-your-own.
vi.mock("./pages/tools/AdvancedToolsRoute", async () => {
  const { useParams } = await import("react-router-dom");
  return {
    AdvancedToolsRoute: () => {
      const { tab } = useParams<{ tab?: string }>();
      if (tab === "profiles") return <div>PROFILES_TAB_MOUNTED</div>;
      if (tab === "gateways") return <div>GATEWAYS_TAB_MOUNTED</div>;
      return <div>RUN_YOUR_OWN_TAB_MOUNTED</div>;
    },
  };
});

const PAP_COMPANY = {
  id: "company-1",
  name: "Paperclip",
  issuePrefix: "PAP",
  status: "active",
};

vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return root;
}

describe("App advanced tools routing", () => {
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

  it.each([
    ["profiles", "PROFILES_TAB_MOUNTED"],
    ["gateways", "GATEWAYS_TAB_MOUNTED"],
  ])("preserves the %s tab param through the real prefixed route tree", async (tab, expected) => {
    const root = renderAppAt(container, `/PAP/apps/advanced/${tab}`);

    await vi.waitFor(() => expect(container.textContent).toContain(expected));
    expect(container.textContent).not.toContain("RUN_YOUR_OWN_TAB_MOUNTED");

    flushSync(() => root.unmount());
  });
});
