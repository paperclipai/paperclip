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

  it("renders the LET-503 single-noun primary rail in contract order", () => {
    renderAt("/eaos");
    const links = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-primary-nav-label-"]') ?? [],
    ).map((node) => node.textContent?.trim());
    expect(links).toEqual([
      "Dashboard",
      "Missions",
      "Agents",
      "Org",
      "Projects",
      "Runs",
      "Approvals",
      "Knowledge",
      "Agent Builder",
      "Admin",
    ]);
  });

  it("renders the rail as a single group (no Operator/Build-Admin headers)", () => {
    renderAt("/eaos");
    const primaryGroup = container?.querySelector(
      '[data-testid="eaos-primary-nav-group-primary"]',
    );
    const secondaryGroup = container?.querySelector(
      '[data-testid="eaos-primary-nav-group-secondary"]',
    );
    expect(primaryGroup).not.toBeNull();
    expect(secondaryGroup).toBeNull();
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
