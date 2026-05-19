// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

// React 19 only exports `act` from `react` when the development bundle is
// loaded, which requires `process.env.NODE_ENV !== "production"`. Some QA
// environments pin NODE_ENV to "production" before vitest starts, which
// causes React to load the production bundle and the shell tests to render
// nothing (silent commit-phase errors in jsdom). Force a non-production
// NODE_ENV before any React import is evaluated using `vi.hoisted`, which
// runs ahead of the hoisted ESM imports below. Pattern copied from the
// LET-352 Eaos.test.tsx fix.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { EaosShell } from "./EaosShell";
import { actSync } from "./test-helpers";

// The shell renders Link / NavLink wrappers from @/lib/router, which call
// useCompany(). Provide a deterministic stub so the wrappers degrade to plain
// react-router links when no company is selected.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null }),
}));

let container: HTMLDivElement | null = null;

function renderAt(initialPath: string, variant: "eaos" | "kernel" = "eaos") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actSync(() => {
    root.render(
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

describe("EaosShell", () => {
  it("renders the required ARIA landmarks for the EAOS variant nested inside Layout", () => {
    renderAt("/eaos");
    // Layout owns the page-level <main>; the inner shell exposes its own
    // banner, navigation, region, and contentinfo landmarks instead.
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

  it("renders the LET-459 operator/build/admin tiers in order", () => {
    renderAt("/eaos");
    const links = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-primary-nav-label-"]') ?? [],
    ).map((node) => node.textContent?.trim());
    expect(links).toEqual([
      // Primary operator tier — LET-459 §"IA principle"
      "Command Center",
      "Missions",
      "Agents / Teams",
      "Approvals / Risk",
      "Knowledge / Playbooks",
      // Demoted Build/Admin tier
      "Projects / Goals",
      "Runs / Observability",
      "Capabilities / MCP",
      "Sandbox / Runtime",
      "Admin / Security",
      // Kernel escape hatch
      "Kernel / Admin",
    ]);
  });

  it("renders the operator tier in a separate group from the Build/Admin tier", () => {
    renderAt("/eaos");
    const primaryGroup = container?.querySelector(
      '[data-testid="eaos-primary-nav-group-primary"]',
    );
    const secondaryGroup = container?.querySelector(
      '[data-testid="eaos-primary-nav-group-secondary"]',
    );
    expect(primaryGroup).not.toBeNull();
    expect(secondaryGroup).not.toBeNull();
    const primaryLabels = Array.from(
      primaryGroup?.querySelectorAll('[data-testid^="eaos-primary-nav-label-"]') ?? [],
    ).map((node) => node.textContent?.trim());
    expect(primaryLabels).toEqual([
      "Command Center",
      "Missions",
      "Agents / Teams",
      "Approvals / Risk",
      "Knowledge / Playbooks",
    ]);
  });

  it("renders the child Outlet for the index route", () => {
    renderAt("/eaos");
    const child = container?.querySelector('[data-testid="child-content"]');
    expect(child).not.toBeNull();
  });

  it("renders the kernel chip when mounted with variant=kernel", () => {
    renderAt("/k/", "kernel");
    const labels = Array.from(
      container?.querySelectorAll('[data-eaos-state]') ?? [],
    ).map((node) => node.textContent ?? "");
    const hasKernelChip = labels.some((text) => text.includes("Kernel/Admin"));
    expect(hasKernelChip).toBe(true);
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

  it("exposes a visible kernel escape hatch in the top bar", () => {
    renderAt("/eaos");
    const hatch = container?.querySelector('[data-testid="eaos-topbar-kernel-hatch"]');
    expect(hatch).not.toBeNull();
    expect(hatch?.getAttribute("aria-label")).toContain("kernel");
  });

  it("renders the bottom posture strip with the audit pin", () => {
    renderAt("/eaos");
    const strip = container?.querySelector('[data-testid="eaos-posture-strip"]');
    expect(strip).not.toBeNull();
    const audit = container?.querySelector('[data-testid="eaos-posture-strip-audit"]');
    expect(audit?.textContent ?? "").toContain("Audit");
  });
});
