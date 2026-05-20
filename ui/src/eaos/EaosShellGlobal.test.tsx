// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

// React 19 production-bundle workaround — see EaosShell.test.tsx for full
// context. Must run before any React import is evaluated.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EaosShell } from "./EaosShell";
import { CommandCenterLanding } from "./CommandCenterLanding";
import { EaosZonePlaceholder } from "./EaosZonePlaceholder";
import { EAOS_PRIMARY_NAV, EAOS_LEGACY_SECONDARY_PATHS } from "./nav-zones";
import { actSync, flushReactQuery } from "./test-helpers";

// LET-484 — CommandCenterLanding reads live mission/agent feeds. Mock the
// api modules and provide a query client so the route smoke tests stay
// hermetic and don't accidentally hit network in jsdom.
vi.mock("@/api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

// The top bar's Kernel hatch is now operator-gated (LET-503 review fix).
// The route smoke tests verify the hatch URL when it is rendered, so we
// pin board access to an instance admin so the hatch is visible and the
// href assertions still cover the routing behavior.
vi.mock("@/api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: vi.fn().mockResolvedValue({
      user: { id: "user-1", email: null, name: "Test Admin", image: null },
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      source: "test-fixture",
      keyId: null,
    }),
  },
}));

// LET-415: /eaos and /agent-os are global, unprefixed product routes. The
// shell links must NEVER be auto-prefixed with a company, even when a company
// is selected in CompanyContext.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

let container: HTMLDivElement | null = null;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function renderShellAt(initialPath: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actSync(() => {
    root.render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="eaos" element={<EaosShell variant="eaos" />}>
              <Route index element={<CommandCenterLanding />} />
              {EAOS_PRIMARY_NAV.filter((zone) => zone.path !== "/eaos").map((zone) => (
                <Route
                  key={zone.id}
                  path={zone.path.replace(/^\/eaos\//, "")}
                  element={<EaosZonePlaceholder title={zone.label} description={zone.description} />}
                />
              ))}
              {EAOS_LEGACY_SECONDARY_PATHS.map((path) => (
                <Route
                  key={path}
                  path={path.replace(/^\/eaos\//, "")}
                  element={<EaosZonePlaceholder title={path} description="legacy secondary route" />}
                />
              ))}
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flushReactQuery();
  return { root };
}

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
});

describe("EaosShell as global /eaos product route (LET-415 / LET-503)", () => {
  it("renders zone nav hrefs unprefixed under /eaos, even with a selected company", async () => {
    await renderShellAt("/eaos/missions");

    const navLinks = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-primary-nav-link-"]') ?? [],
    ) as HTMLAnchorElement[];
    expect(navLinks.length).toBeGreaterThan(0);

    const hrefById = new Map(
      navLinks.map((node) => [node.getAttribute("data-testid"), node.getAttribute("href")] as const),
    );
    expect(hrefById.get("eaos-primary-nav-link-command-center")).toBe("/eaos");
    expect(hrefById.get("eaos-primary-nav-link-missions")).toBe("/eaos/missions");
    expect(hrefById.get("eaos-primary-nav-link-org")).toBe("/eaos/org");
    expect(hrefById.get("eaos-primary-nav-link-approvals")).toBe("/eaos/approvals");

    for (const [testid, href] of hrefById.entries()) {
      expect(href, `${testid} must be the unprefixed /eaos product route`).toMatch(
        /^\/eaos(?:$|\/)/,
      );
      expect(href, `${testid} must not leak a /<companyPrefix>/eaos path`).not.toMatch(
        /^\/PAP\//,
      );
    }
  });

  it("marks the active Missions zone NavLink as aria-current on /eaos/missions", async () => {
    await renderShellAt("/eaos/missions");

    const missionsLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-missions"]',
    );
    expect(missionsLink).not.toBeNull();
    expect(missionsLink?.getAttribute("aria-current")).toBe("page");

    const dashboardLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-command-center"]',
    );
    expect(dashboardLink?.getAttribute("aria-current")).not.toBe("page");
  });

  it("marks the Dashboard NavLink as aria-current on /eaos root", async () => {
    await renderShellAt("/eaos");

    const dashboardLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-command-center"]',
    );
    expect(dashboardLink?.getAttribute("aria-current")).toBe("page");
  });

  it("routes the kernel/admin escape hatch in the top bar to /<company>/dashboard", async () => {
    // /dashboard is still a board route, so the company prefix is reapplied
    // by @/lib/router. With selectedCompany=PAP this becomes /PAP/dashboard,
    // which keeps the kernel hatch pointing at the right per-company kernel.
    await renderShellAt("/eaos/missions");

    const hatch = container?.querySelector('[data-testid="eaos-topbar-kernel-hatch"]');
    expect(hatch?.getAttribute("href")).toBe("/PAP/dashboard");
  });

  it("does NOT render top-bar stub indicator badges anymore (LET-503)", async () => {
    await renderShellAt("/eaos");

    const stubIndicators = container?.querySelectorAll('[data-eaos-indicator-stub="true"]');
    expect(stubIndicators?.length ?? 0).toBe(0);
  });

  it("renders the brand link back to /eaos", async () => {
    await renderShellAt("/eaos/missions");
    const brand = container?.querySelector('header[role="banner"] a');
    expect(brand?.getAttribute("href")).toBe("/eaos");
  });
});
