// @vitest-environment jsdom

// Chat identity confirmation links are issued as unprefixed
// `/chat-identity/confirm?token=...` URLs. The first segment must not be read
// as a company prefix, and a company-prefixed copy of the link must land on
// the same confirmation page with its token intact.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __chatIdentityRoutingPatched?: boolean;
  };
  if (!sheetProto.__chatIdentityRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".chat-identity-routing-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__chatIdentityRoutingPatched = true;
  }
});

vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

vi.mock("./pages/apps/chat/ChatIdentityConfirm", async () => {
  const { useLocation } = await import("react-router-dom");
  return {
    ChatIdentityConfirm: () => {
      const location = useLocation();
      return <div>{`CHAT_IDENTITY_CONFIRM_PAGE ${location.pathname}${location.search}`}</div>;
    },
  };
});

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

const GRO_COMPANY = {
  id: "company-1",
  name: "Growth",
  issuePrefix: "GRO",
  status: "active",
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [GRO_COMPANY],
    selectedCompanyId: GRO_COMPANY.id,
    selectedCompany: GRO_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function renderAppAt(container: HTMLElement, path: string) {
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

async function waitForRoute(container: HTMLElement, text: string) {
  await vi.waitFor(() => expect(container.textContent).toContain(text));
}

describe("App chat identity confirmation routing", () => {
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

  it("renders the confirmation page for the unprefixed link", async () => {
    const root = await renderAppAt(container, "/chat-identity/confirm?token=synthetic-token");
    await waitForRoute(container, "CHAT_IDENTITY_CONFIRM_PAGE /chat-identity/confirm?token=synthetic-token");
    flushSync(() => root.unmount());
  });

  it("redirects the company-prefixed link to the confirmation page", async () => {
    const root = await renderAppAt(container, "/GRO/chat-identity/confirm?token=synthetic-token");
    await waitForRoute(container, "CHAT_IDENTITY_CONFIRM_PAGE /chat-identity/confirm?token=synthetic-token");
    expect(container.textContent).not.toContain("Page not found");
    flushSync(() => root.unmount());
  });
});
