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
import { EaosShell } from "./EaosShell";
import { CommandCenterLanding } from "./CommandCenterLanding";
import { EaosZonePlaceholder } from "./EaosZonePlaceholder";
import { EAOS_PRIMARY_NAV } from "./nav-zones";
import { actSync } from "./test-helpers";

// Stub CompanyContext so the @/lib/router Link / NavLink wrappers can resolve
// useCompany() without a full provider tree. The hook also reads the
// `:companyPrefix` route param and the location's first segment — both of
// which provide "PAP" naturally for these prefixed renders. The stub stays
// the load-bearing source only as a fallback.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

let container: HTMLDivElement | null = null;

function renderShellAt(initialPath: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actSync(() => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path=":companyPrefix">
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
          </Route>
        </Routes>
      </MemoryRouter>,
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

describe("EaosShell under prefixed company route", () => {
  it("renders zone nav hrefs under the active /<companyPrefix>/eaos/... scope", () => {
    renderShellAt("/PAP/eaos/sandbox");

    const navLinks = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-primary-nav-link-"]') ?? [],
    ) as HTMLAnchorElement[];
    expect(navLinks.length).toBeGreaterThan(0);

    const hrefById = new Map(
      navLinks.map((node) => [node.getAttribute("data-testid"), node.getAttribute("href")] as const),
    );
    expect(hrefById.get("eaos-primary-nav-link-command-center")).toBe("/PAP/eaos");
    expect(hrefById.get("eaos-primary-nav-link-sandbox-runtime")).toBe("/PAP/eaos/sandbox");
    expect(hrefById.get("eaos-primary-nav-link-approvals-risk")).toBe("/PAP/eaos/approvals");
    expect(hrefById.get("eaos-primary-nav-link-missions")).toBe("/PAP/eaos/missions");

    for (const [testid, href] of hrefById.entries()) {
      if (testid === "eaos-primary-nav-link-kernel-admin") continue;
      expect(href, `${testid} should be prefixed`).toMatch(/^\/PAP\/eaos(?:$|\/)/);
      expect(href, `${testid} should not leak unprefixed /eaos`).not.toMatch(/^\/eaos(?:$|\/|\?)/);
    }
  });

  it("marks the active sandbox zone NavLink as aria-current under the prefixed scope", () => {
    renderShellAt("/PAP/eaos/sandbox");

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

  it("marks the index Command Center NavLink as aria-current on the /<prefix>/eaos root", () => {
    renderShellAt("/PAP/eaos");

    const commandCenterLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-command-center"]',
    );
    expect(commandCenterLink).not.toBeNull();
    expect(commandCenterLink?.getAttribute("aria-current")).toBe("page");

    const sandboxLink = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-sandbox-runtime"]',
    );
    expect(sandboxLink?.getAttribute("aria-current")).not.toBe("page");
  });

  it("routes the kernel/admin escape hatch to /<prefix>/dashboard, not the unprefixed root", () => {
    renderShellAt("/PAP/eaos/sandbox");

    const hatch = container?.querySelector('[data-testid="eaos-topbar-kernel-hatch"]');
    expect(hatch?.getAttribute("href")).toBe("/PAP/dashboard");

    const sidebarKernel = container?.querySelector(
      '[data-testid="eaos-primary-nav-link-kernel-admin"]',
    );
    expect(sidebarKernel?.getAttribute("href")).toBe("/PAP/dashboard");
  });

  it("prefixes the top-bar brand link and indicator links with the active company", () => {
    renderShellAt("/PAP/eaos/sandbox");

    const brand = container?.querySelector("header[role=\"banner\"] a");
    expect(brand?.getAttribute("href")).toBe("/PAP/eaos");

    const approvalsIndicator = container?.querySelector(
      '[data-testid="eaos-topbar-indicator-approvals"]',
    );
    expect(approvalsIndicator?.getAttribute("href")).toBe("/PAP/eaos/approvals?scope=mine");

    const riskIndicator = container?.querySelector('[data-testid="eaos-topbar-indicator-risk"]');
    expect(riskIndicator?.getAttribute("href")).toBe("/PAP/eaos/approvals?tab=risk");

    const loopIndicator = container?.querySelector('[data-testid="eaos-topbar-indicator-loop"]');
    expect(loopIndicator?.getAttribute("href")).toBe("/PAP/eaos/loops");

    const inboxIndicator = container?.querySelector(
      '[data-testid="eaos-topbar-indicator-notifications"]',
    );
    expect(inboxIndicator?.getAttribute("href")).toBe("/PAP/eaos/inbox");
  });

  it("prefixes Command Center landing card 'View ...' links under the prefixed scope", () => {
    renderShellAt("/PAP/eaos");

    const cardLinks = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-landing-card-"] a') ?? [],
    ) as HTMLAnchorElement[];
    expect(cardLinks.length).toBeGreaterThan(0);
    for (const anchor of cardLinks) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href, `${anchor.textContent ?? "card link"} must be prefixed`).toMatch(
        /^\/PAP\/eaos\//,
      );
    }
  });
});
