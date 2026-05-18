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
import { CommandCenterLanding } from "./CommandCenterLanding";
import { EaosShell } from "./EaosShell";
import { EaosZonePlaceholder } from "./EaosZonePlaceholder";
import { EAOS_PRIMARY_NAV } from "./nav-zones";
import { actSync } from "./test-helpers";

// The shell now consumes the @/lib/router company-aware Link/NavLink
// wrappers, which read from CompanyContext. Stub the context here so the
// unprefixed renders keep their current behavior (no company prefix added).
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null }),
}));

let container: HTMLDivElement | null = null;

function renderEaosPath(initialPath = "/eaos") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actSync(() => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="eaos/*" element={<EaosShell />}>
            <Route index element={<CommandCenterLanding />} />
            <Route
              path="projects"
              element={
                <EaosZonePlaceholder
                  title="Projects / Goals"
                  description="Strategic outcomes, roadmaps, release candidates."
                />
              }
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

describe("EAOS semantic posture labels", () => {
  it("labels command-center cards as Data PREVIEW and not connected, not backend-backed data", () => {
    renderEaosPath("/eaos");

    const landing = container?.querySelector('[data-testid="eaos-command-center-landing"]');
    expect(landing?.getAttribute("data-eaos-data-connected")).toBe("false");
    expect(landing?.textContent ?? "").toContain("Shell · BACKEND-BACKED");
    expect(landing?.textContent ?? "").toContain("Data · PREVIEW");
    expect(landing?.textContent ?? "").toContain("Not connected");

    const cards = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-landing-card-"]') ?? [],
    );
    expect(cards.length).toBe(EAOS_PRIMARY_NAV.length - 1);
    for (const card of cards) {
      const text = card.textContent ?? "";
      expect(card.getAttribute("data-eaos-data-connected")).toBe("false");
      expect(text).toContain("Data · PREVIEW");
      expect(text).toContain("Not connected");
      expect(text).not.toContain("Data · BACKEND-BACKED");
      expect(text).not.toContain("Posture · BACKEND-BACKED");
    }
  });

  it("dual-labels zone placeholders without claiming backend-backed data", () => {
    renderEaosPath("/eaos/projects");

    const placeholder = container?.querySelector('[data-testid="eaos-zone-placeholder"]');
    expect(placeholder?.getAttribute("data-eaos-data-connected")).toBe("false");
    const text = placeholder?.textContent ?? "";
    expect(text).toContain("Shell · BACKEND-BACKED");
    expect(text).toContain("Data · PREVIEW");
    expect(text).toContain("Not connected");
    expect(text).not.toContain("Data · BACKEND-BACKED");
    expect(text).not.toContain("Posture · BACKEND-BACKED");
  });

  it("makes scope and stub counts visibly non-real until read models are wired", () => {
    renderEaosPath("/eaos");

    const scope = container?.querySelector('[data-testid="eaos-topbar-scope"]');
    expect(scope?.textContent ?? "").toContain("Scope preview · Not connected");
    expect(scope?.textContent ?? "").not.toContain("Company · Project");

    const indicatorBadges = Array.from(
      container?.querySelectorAll('[data-eaos-indicator-stub="true"] span:last-child') ?? [],
    );
    expect(indicatorBadges.length).toBeGreaterThan(0);
    for (const badge of indicatorBadges) {
      expect(badge.textContent?.trim()).toBe("Stub");
    }

    const navBadges = Array.from(container?.querySelectorAll('[data-eaos-nav-count-stub="true"]') ?? []);
    expect(navBadges.length).toBeGreaterThan(0);
    for (const badge of navBadges) {
      expect(badge.textContent?.trim()).toBe("Stub");
      expect(badge.getAttribute("aria-label") ?? "").toContain("preview count · not connected");
    }
  });

  it("pairs the bottom shell posture with an explicit Data PREVIEW not-connected chip", () => {
    renderEaosPath("/eaos");

    const strip = container?.querySelector('[data-testid="eaos-posture-strip"]');
    expect(strip?.getAttribute("data-eaos-data-connected")).toBe("false");
    const text = strip?.textContent ?? "";
    expect(text).toContain("Shell · BACKEND-BACKED");
    expect(text).toContain("Data · PREVIEW");
    expect(text).toContain("Not connected");
    expect(text).not.toContain("Posture · BACKEND-BACKED");
  });
});
