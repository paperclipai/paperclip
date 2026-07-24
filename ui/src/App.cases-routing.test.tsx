// @vitest-environment jsdom

// Regression guard for PAP-13002: the experimental Cases UI emits *unprefixed*
// links (`/cases`, `/cases/:id`) — the same global-unprefixed pattern Pipelines
// uses. Those only resolve if `cases` and `cases/:caseIdentifier` are registered
// as reserved unprefixed redirect routes in <App>; otherwise the first path
// segment is parsed as a company prefix ("CASES") and the page 404s with
// "No company matches prefix". This drives the real <App> route table so a
// future removal of those redirect routes fails loudly.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
// (sandpack itself is never exercised by the routing under test.)
beforeAll(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __pap13002Patched?: boolean;
  };
  if (!sheetProto.__pap13002Patched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap13002-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__pap13002Patched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries) and
// owns the "No company matches prefix" NotFound. For routing we only need it to
// resolve the :companyPrefix segment and render its nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

// The experimental gate would otherwise hide the page behind a feature flag.
vi.mock("./components/CasesExperimentalGate", () => ({
  CasesExperimentalGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Rendered by <App> outside <Routes> and needs DialogProvider; irrelevant here.
vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Sentinel pages so we can assert *which* route resolved.
vi.mock("./pages/Cases", () => ({ Cases: () => <div>CASES_LIST_PAGE</div> }));
vi.mock("./pages/CaseDetail", () => ({ CaseDetail: () => <div>CASE_DETAIL_PAGE</div> }));

// CloudAccessGate must fall through to <Outlet/> (authorized w/ company access).
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
  claimBootstrapAdmin: vi.fn(),
}));
vi.mock("./api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("./api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("./api/access", () => ({ accessApi: mockAccessApi }));

// The prefix resolver + redirect logic both read the active company.
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

async function flushReact() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await flushReact();
  }
  expect(container.textContent).toContain(text);
}

async function renderAppAt(container: HTMLElement, path: string) {
  const { App } = await import("./App");
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("App Cases routing (PAP-13002)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bootstrapStatus: "ready",
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [PAP_COMPANY.id],
      source: "session",
      keyId: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("redirects unprefixed /cases to the company-prefixed list page", async () => {
    const root = await renderAppAt(container, "/cases");
    await waitForText(container, "CASES_LIST_PAGE");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  }, 20000);

  it("redirects unprefixed /cases/:id to the company-prefixed detail page", async () => {
    const root = await renderAppAt(container, "/cases/PAP-C5");
    await waitForText(container, "CASE_DETAIL_PAGE");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  }, 20000);
});
