// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

// React 19 only exports `act` from `react` when the development bundle is
// loaded, which requires `process.env.NODE_ENV !== "production"`. Some QA
// environments pin NODE_ENV to "production" before vitest starts, which
// causes React to load the production bundle and the shell tests to render
// nothing (silent commit-phase errors in jsdom). Force a non-production
// NODE_ENV before any React import is evaluated using `vi.hoisted`, which
// runs ahead of the hoisted ESM imports below.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DialogProvider } from "@/context/DialogContext";
import { EaosShell } from "./EaosShell";
import { actSync, flushReactQuery } from "./test-helpers";

// The shell renders Link / NavLink wrappers from @/lib/router, which call
// useCompany(). Provide a deterministic stub so the wrappers degrade to plain
// react-router links when no company is selected.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null }),
}));

// LET-503 review fix: the top bar's Kernel hatch + posture-strip audit
// footer are operator-gated, so the shell now reads access via
// `accessApi.getCurrentBoardAccess()`. Pin the access mock to an
// instance admin so the original landmark/visibility assertions in this
// file (which all assume the operator chrome is present) stay valid.
vi.mock("@/api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: vi.fn().mockResolvedValue({
      user: { id: "user-1", email: null, name: "Test Admin", image: null },
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: [],
      memberships: [],
      source: "test-fixture",
      keyId: null,
    }),
  },
}));

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

let container: HTMLDivElement | null = null;

function renderAt(initialPath: string, variant: "eaos" | "kernel" = "eaos") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actSync(() => {
    root.render(
      <QueryClientProvider client={makeQueryClient()}>
        <DialogProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path={variant === "kernel" ? "k/*" : "eaos/*"} element={<EaosShell variant={variant} />}>
                <Route index element={<div data-testid="child-content">EAOS child content</div>} />
                <Route
                  path="other"
                  element={<div data-testid="child-content-other">Other content</div>}
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </DialogProvider>
      </QueryClientProvider>,
    );
  });
  return { root };
}

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
});

describe("EaosShell", () => {
  it("renders the required ARIA landmarks for the EAOS variant nested inside Layout", () => {
    renderAt("/eaos");
    expect(container?.querySelector('header[role="banner"]')).not.toBeNull();
    expect(container?.querySelector('nav[role="navigation"]')).not.toBeNull();
    expect(container?.querySelector('section[role="region"]')).not.toBeNull();
    expect(container?.querySelector('footer[role="contentinfo"]')).not.toBeNull();
  });

  it("does not double up the page <main> landmark already owned by Layout", () => {
    renderAt("/eaos");
    expect(container?.querySelector("main")).toBeNull();
  });

  it("anchors the section content with the eaos-section-content id", () => {
    renderAt("/eaos");
    const section = container?.querySelector('section[role="region"]');
    expect(section?.getAttribute("id")).toBe("eaos-section-content");
  });

  it("renders the LET-506 grouped Multica-style rail in contract order (operator)", async () => {
    renderAt("/eaos");
    // The Admin entry is operator-gated and the access query resolves
    // asynchronously, so flush the query microtasks before asserting on
    // the rail order. The mock above pins isInstanceAdmin=true, so once
    // the query settles the operator-only Admin entry must be visible.
    await flushReactQuery();
    const links = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-primary-nav-label-"]') ?? [],
    ).map((node) => node.textContent?.trim());
    // LET-506 (Multica adaptation): Dashboard sits in the unlabeled
    // Personal section, the Workspace group lists work surfaces in mission
    // priority order, and Configure trails with Agent Builder + the
    // operator-only Admin entry.
    expect(links).toEqual([
      "Dashboard",
      "Missions",
      "Projects",
      "Agents",
      "Org",
      "Runs",
      "Approvals",
      "Knowledge",
      "Agent Builder",
      "Admin",
    ]);
  });

  it("hides the Admin rail entry for customer-member viewers", async () => {
    // Re-mock the access query as a non-operator customer-member; we
    // import the EaosShell again after the mock so the new fixture is
    // applied to the new render.
    vi.doMock("@/api/access", () => ({
      accessApi: {
        getCurrentBoardAccess: vi.fn().mockResolvedValue({
          user: { id: "user-2", email: null, name: "Customer Member", image: null },
          userId: "user-2",
          isInstanceAdmin: false,
          companyIds: [],
          memberships: [],
          source: "test-fixture",
          keyId: null,
        }),
      },
    }));
    vi.resetModules();
    const { EaosShell: CustomerShell } = await import("./EaosShell");
    const { DialogProvider: ResetDialogProvider } = await import("@/context/DialogContext");
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    actSync(() => {
      root.render(
        <QueryClientProvider client={makeQueryClient()}>
          <ResetDialogProvider>
            <MemoryRouter initialEntries={["/eaos"]}>
              <Routes>
                <Route path="eaos/*" element={<CustomerShell variant="eaos" />}>
                  <Route index element={<div data-testid="child-content">EAOS child content</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </ResetDialogProvider>
        </QueryClientProvider>,
      );
    });
    await flushReactQuery();
    const labels = Array.from(
      container.querySelectorAll('[data-testid^="eaos-primary-nav-label-"]'),
    ).map((node) => node.textContent?.trim());
    expect(labels).not.toContain("Admin");
    const adminLink = container.querySelector(
      '[data-testid="eaos-primary-nav-link-admin"]',
    );
    expect(adminLink).toBeNull();
    vi.doUnmock("@/api/access");
    root.unmount();
  });

  it("renders the LET-506 Multica-style group structure (Personal unlabeled, Workspace, Configure)", () => {
    renderAt("/eaos");
    // Multica's sidebar groups Personal/Workspace/Configure; the EAOS
    // adaptation renders the Personal section unlabeled (Dashboard sits
    // flush below the search/new-mission header) and labels the Workspace
    // + Configure groups for screen readers and the visual hierarchy.
    expect(
      container?.querySelector('[data-testid="eaos-primary-nav-group-personal"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-primary-nav-group-workspace"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-primary-nav-group-configure"]'),
    ).not.toBeNull();
    // Legacy single-group testid from LET-503 is gone — guard against
    // resurrection.
    expect(
      container?.querySelector('[data-testid="eaos-primary-nav-group-primary"]'),
    ).toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-primary-nav-group-secondary"]'),
    ).toBeNull();
  });

  it("renders the Multica-style Search + New mission header triggers in the sidebar", () => {
    renderAt("/eaos");
    const searchTrigger = container?.querySelector(
      '[data-testid="eaos-primary-nav-search"]',
    );
    const newMissionTrigger = container?.querySelector(
      '[data-testid="eaos-primary-nav-new-mission"]',
    );
    expect(searchTrigger).not.toBeNull();
    expect(newMissionTrigger).not.toBeNull();
    expect(searchTrigger?.getAttribute("aria-label")).toContain("Search");
    expect(newMissionTrigger?.getAttribute("aria-label")).toContain("New mission");
  });

  it("does not render dashed Stub count pills in the rail", () => {
    renderAt("/eaos");
    const stubBadges = container?.querySelectorAll('[data-eaos-nav-count-stub="true"]');
    expect(stubBadges?.length ?? 0).toBe(0);
  });

  it("does not render the kernel-admin entry inside the primary rail", () => {
    renderAt("/eaos");
    const kernelLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-kernel-admin"]',
    );
    expect(kernelLink).toBeNull();
  });

  it("renders the child Outlet for the index route", () => {
    renderAt("/eaos");
    const child = container?.querySelector('[data-testid="child-content"]');
    expect(child).not.toBeNull();
  });

  it("renders the kernel top-bar label when mounted with variant=kernel", () => {
    renderAt("/k/", "kernel");
    const banner = container?.querySelector('header[role="banner"]');
    expect(banner?.getAttribute("aria-label")).toBe("Kernel/Admin top bar");
  });

  it("renders the command palette trigger with accessible name", () => {
    renderAt("/eaos");
    const trigger = container?.querySelector(
      '[data-testid="eaos-topbar-command-palette-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toContain("command palette");
  });

  it("exposes a visible kernel escape hatch button in the top bar for operator-class viewers", async () => {
    renderAt("/eaos");
    // The hatch is now operator-gated; wait for the access query to
    // resolve so the admin fixture flips isOperator before asserting.
    await flushReactQuery();
    const hatch = container?.querySelector('[data-testid="eaos-topbar-kernel-hatch"]');
    expect(hatch).not.toBeNull();
    expect((hatch?.getAttribute("aria-label") ?? "").toLowerCase()).toContain("kernel");
  });

  it("renders the bottom posture strip with the audit pin for operator-class viewers", async () => {
    renderAt("/eaos");
    await flushReactQuery();
    const strip = container?.querySelector('[data-testid="eaos-posture-strip"]');
    expect(strip).not.toBeNull();
    const audit = container?.querySelector('[data-testid="eaos-posture-strip-audit"]');
    expect(audit?.textContent ?? "").toContain("Audit");
  });
});
