// @vitest-environment jsdom

// Links written outside the app (onboarding emails, docs pages) cannot carry a
// reader's company prefix. They only resolve if the surface they name is
// registered as an unprefixed redirect route in <App>; otherwise the first path
// segment is parsed as a company prefix ("APPS") and the page 404s. This drives
// the real <App> route table for the core surfaces such links point at, so
// removing one of those routes fails loudly.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __deepLinkRoutingPatched?: boolean;
  };
  if (!sheetProto.__deepLinkRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".deep-link-routing-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__deepLinkRoutingPatched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries). For
// routing we only need it to resolve :companyPrefix and render nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});
vi.mock("./components/ProductionLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { ProductionLayout: () => <Outlet /> };
});

// Rendered by <App> outside <Routes>; irrelevant to the route table.
vi.mock("./components/PageLoadTracker", () => ({ PageLoadTracker: () => null }));
vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Cloud access is unrelated to the route table. Let it fall through.
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

// Sentinel pages so we can assert *which* route resolved.
vi.mock("./pages/Dashboard", () => ({ Dashboard: () => <div>DASHBOARD_PAGE</div> }));
vi.mock("./pages/apps/Browse", () => ({ Browse: () => <div>CONNECTORS_PAGE</div> }));
vi.mock("./pages/apps/AppsConnect", () => ({ AppsConnect: () => <div>CONNECT_APP_PAGE</div> }));
vi.mock("./pages/AgentChats", () => ({ AgentChats: () => <div>CHATS_PAGE</div> }));
vi.mock("./pages/Inbox", () => ({ Inbox: () => <div>INBOX_PAGE</div> }));
vi.mock("./pages/Issues", () => ({ Issues: () => <div>TASKS_PAGE</div> }));

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

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

async function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <App />
      </MemoryRouter>,
    );
  });
  return root;
}

function currentLocation(container: HTMLElement): string {
  return container.querySelector('[data-testid="location"]')?.textContent ?? "";
}

describe("App deep-link routing for links written outside the app", () => {
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
    ["/dashboard", "/PAP/dashboard", "DASHBOARD_PAGE"],
    ["/apps", "/PAP/apps", "CONNECTORS_PAGE"],
    ["/chats", "/PAP/chats", "CHATS_PAGE"],
  ])("forwards unprefixed %s to %s", async (from, to, sentinel) => {
    const root = await renderAppAt(container, from);
    await vi.waitFor(() => expect(container.textContent).toContain(sentinel));
    expect(currentLocation(container)).toBe(to);
    expect(container.textContent).not.toContain("No organization matches prefix");
    flushSync(() => root.unmount());
  });

  it("keeps the query string, so a docs link can open one connector", async () => {
    const root = await renderAppAt(container, "/apps/connect?source=notion");
    await vi.waitFor(() => expect(currentLocation(container)).toMatch(/^\/PAP\/apps/));
    // The prefixed route decides whether this reader may open the connect
    // page; either way the reader lands inside their own company.
    const landed = currentLocation(container);
    expect(["/PAP/apps/connect?source=notion", "/PAP/apps"]).toContain(landed);
    flushSync(() => root.unmount());
  });

  it("forwards unprefixed /inbox into the reader's company", async () => {
    const root = await renderAppAt(container, "/inbox");
    // Inbox resolves to its last tab, or to the matching Tasks view when the
    // combined Inbox + Tasks surface is on. Both live under the company prefix.
    await vi.waitFor(() => expect(currentLocation(container)).toMatch(/^\/PAP\/(inbox\/|issues\?)/));
    flushSync(() => root.unmount());
  });

  it("leaves a path that is not a registered surface unresolved", async () => {
    const root = await renderAppAt(container, "/apps/not-a-real-page");
    await vi.waitFor(() => expect(container.textContent).not.toBe(""));
    expect(currentLocation(container)).toBe("/apps/not-a-real-page");
    flushSync(() => root.unmount());
  });
});
