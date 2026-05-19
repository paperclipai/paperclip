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
import { EAOS_PRIMARY_NAV } from "./nav-zones";
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

// LET-415: /eaos and /agent-os are global, unprefixed product routes. The
// shell links must NEVER be auto-prefixed with a company, even when a company
// is selected in CompanyContext. The router wrapper at @/lib/router consults
// `applyCompanyPrefix`, which (after LET-415) treats "eaos" and "agent-os" as
// GLOBAL_ROUTE_ROOTS — so providing a selectedCompany here is the strongest
// case: if prefixes leak, this test fails.
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
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Drain react-query promises so post-resolve re-renders commit inside an
  // act() boundary — LET-484 reviewer nit #4.
  await flushReactQuery();
  return { root };
}

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
});

describe("EaosShell as global /eaos product route (LET-415)", () => {
  it("renders zone nav hrefs unprefixed under /eaos, even with a selected company", async () => {
    await renderShellAt("/eaos/sandbox");

    const navLinks = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-primary-nav-link-"]') ?? [],
    ) as HTMLAnchorElement[];
    expect(navLinks.length).toBeGreaterThan(0);

    const hrefById = new Map(
      navLinks.map((node) => [node.getAttribute("data-testid"), node.getAttribute("href")] as const),
    );
    expect(hrefById.get("eaos-primary-nav-link-command-center")).toBe("/eaos");
    expect(hrefById.get("eaos-primary-nav-link-sandbox-runtime")).toBe("/eaos/sandbox");
    expect(hrefById.get("eaos-primary-nav-link-approvals-risk")).toBe("/eaos/approvals");
    expect(hrefById.get("eaos-primary-nav-link-missions")).toBe("/eaos/missions");

    for (const [testid, href] of hrefById.entries()) {
      if (testid === "eaos-primary-nav-link-kernel-admin") continue;
      expect(href, `${testid} must be the unprefixed /eaos product route`).toMatch(
        /^\/eaos(?:$|\/)/,
      );
      expect(href, `${testid} must not leak a /<companyPrefix>/eaos path`).not.toMatch(
        /^\/PAP\//,
      );
    }
  });

  it("marks the active sandbox zone NavLink as aria-current on /eaos/sandbox", async () => {
    await renderShellAt("/eaos/sandbox");

    const sandboxLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-sandbox-runtime"]',
    );
    expect(sandboxLink).not.toBeNull();
    expect(sandboxLink?.getAttribute("aria-current")).toBe("page");

    const commandCenterLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-command-center"]',
    );
    expect(commandCenterLink?.getAttribute("aria-current")).not.toBe("page");
  });

  it("marks the Command Center NavLink as aria-current on /eaos root", async () => {
    await renderShellAt("/eaos");

    const commandCenterLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-command-center"]',
    );
    expect(commandCenterLink?.getAttribute("aria-current")).toBe("page");
  });

  it("routes the kernel/admin escape hatch to /dashboard (legacy kernel)", async () => {
    // /dashboard is still a board route, so the company prefix is reapplied
    // by @/lib/router. With selectedCompany=PAP this becomes /PAP/dashboard,
    // which keeps the kernel hatch pointing at the right per-company kernel.
    await renderShellAt("/eaos/sandbox");

    const hatch = container?.querySelector('[data-testid="eaos-topbar-kernel-hatch"]');
    expect(hatch?.getAttribute("href")).toBe("/PAP/dashboard");

    const sidebarKernel = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-kernel-admin"]',
    );
    expect(sidebarKernel?.getAttribute("href")).toBe("/PAP/dashboard");
  });

  it("renders Command Center landing card 'View ...' links unprefixed", async () => {
    await renderShellAt("/eaos");

    const cardLinks = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-landing-card-"] a') ?? [],
    ) as HTMLAnchorElement[];
    expect(cardLinks.length).toBeGreaterThan(0);
    for (const anchor of cardLinks) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href, `${anchor.textContent ?? "card link"} must be unprefixed`).toMatch(
        /^\/eaos\//,
      );
    }
  });

  it("renders top-bar indicator links unprefixed", async () => {
    await renderShellAt("/eaos/sandbox");

    const approvalsIndicator = container?.querySelector(
      '[data-testid="eaos-topbar-indicator-approvals"]',
    );
    expect(approvalsIndicator?.getAttribute("href")).toBe("/eaos/approvals?scope=mine");

    const riskIndicator = container?.querySelector('[data-testid="eaos-topbar-indicator-risk"]');
    expect(riskIndicator?.getAttribute("href")).toBe("/eaos/approvals?tab=risk");

    const loopIndicator = container?.querySelector('[data-testid="eaos-topbar-indicator-loop"]');
    expect(loopIndicator?.getAttribute("href")).toBe("/eaos/loops");

    const inboxIndicator = container?.querySelector(
      '[data-testid="eaos-topbar-indicator-notifications"]',
    );
    expect(inboxIndicator?.getAttribute("href")).toBe("/eaos/inbox");

    const brand = container?.querySelector("header[role=\"banner\"] a");
    expect(brand?.getAttribute("href")).toBe("/eaos");
  });
});
