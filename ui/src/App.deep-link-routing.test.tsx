// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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

vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});
vi.mock("./components/ProductionLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { ProductionLayout: () => <Outlet /> };
});

vi.mock("./components/PageLoadTracker", () => ({ PageLoadTracker: () => null }));
vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

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
    await vi.waitFor(() => expect(container.textContent).toContain("CONNECT_APP_PAGE"));
    expect(currentLocation(container)).toBe("/PAP/apps/connect?source=notion");
    flushSync(() => root.unmount());
  });

  it("sends a connect link with no connector to the Connectors list", async () => {
    const root = await renderAppAt(container, "/apps/connect");
    await vi.waitFor(() => expect(container.textContent).toContain("CONNECTORS_PAGE"));
    expect(currentLocation(container)).toBe("/PAP/apps");
    flushSync(() => root.unmount());
  });

  it("forwards unprefixed /inbox into the reader's company", async () => {
    const root = await renderAppAt(container, "/inbox");
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
