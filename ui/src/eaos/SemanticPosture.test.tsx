// @vitest-environment jsdom
//
// LET-503 (LET-502 contract §3/§5) — the LET-187 dual-chip semantic-trust
// noise (`Shell · BACKEND-BACKED` + `Data · PREVIEW · Not connected` on
// every surface) was removed from the primary chrome. This test now locks
// the post-cleanup invariants:
//   1. Chrome (top bar, posture strip, primary rail) does not advertise
//      the dual chips.
//   2. The Dashboard tiles still show truthful `·` placeholders when no
//      company scope is active (so operators can tell `0` from `n/a`).
//   3. The landing surface still flips `data-eaos-data-connected="false"`
//      when not connected — programmatic truth without visible noise.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DialogProvider } from "@/context/DialogContext";
import { CommandCenterLanding } from "./CommandCenterLanding";
import { EaosShell } from "./EaosShell";
import { actSync, flushReactQuery } from "./test-helpers";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null }),
}));

vi.mock("@/api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

// LET-503 review fix: the audit/operator-session footer is now
// operator-only. These chrome-cleanup assertions are scoped to the
// operator viewer path — pin the access mock to instance admin so the
// posture strip renders the operator chrome the suite is checking
// against.
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

let container: HTMLDivElement | null = null;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderEaosPath(initialPath = "/eaos") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actSync(() => {
    root.render(
      <QueryClientProvider client={makeQueryClient()}>
        <DialogProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="eaos/*" element={<EaosShell />}>
                <Route index element={<CommandCenterLanding />} />
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

describe("EAOS shell chrome (LET-503 cleanup)", () => {
  it("does NOT advertise Shell/Data dual chips on the top bar", () => {
    renderEaosPath("/eaos");
    const banner = container?.querySelector('header[role="banner"]');
    const text = banner?.textContent ?? "";
    expect(text).not.toContain("Shell · BACKEND-BACKED");
    expect(text).not.toContain("Data · PREVIEW");
    expect(text).not.toContain("Data · BACKEND-BACKED");
  });

  it("does NOT advertise Shell/Data dual chips on the bottom posture strip", async () => {
    renderEaosPath("/eaos");
    // The audit/operator-session chrome is operator-gated and resolves
    // asynchronously through the access query; flush before reading.
    await flushReactQuery();
    const strip = container?.querySelector('[data-testid="eaos-posture-strip"]');
    const text = strip?.textContent ?? "";
    expect(text).not.toContain("Shell · BACKEND-BACKED");
    expect(text).not.toContain("Data · PREVIEW");
    expect(text).not.toContain("Data · BACKEND-BACKED");
    // For operator-class viewers (this fixture pins instance admin) the
    // audit pin is the only persistent breadcrumb. Customers see an
    // empty footer instead — covered by the customer-role evidence
    // captured in the LET-503 screenshot runner.
    expect(text).toContain("Audit");
  });

  it("does NOT render dashed Stub count pills in the primary rail", () => {
    renderEaosPath("/eaos");
    const stubBadges = container?.querySelectorAll('[data-eaos-nav-count-stub="true"]');
    expect(stubBadges?.length ?? 0).toBe(0);
  });

  it("does NOT render dashed Stub indicator badges in the top bar", () => {
    renderEaosPath("/eaos");
    const stubIndicators = container?.querySelectorAll('[data-eaos-indicator-stub="true"]');
    expect(stubIndicators?.length ?? 0).toBe(0);
  });

  it("collapses tile values to a `·` placeholder when no company scope is active", () => {
    renderEaosPath("/eaos");

    const landing = container?.querySelector('[data-testid="eaos-command-center-landing"]');
    expect(landing?.getAttribute("data-eaos-data-connected")).toBe("false");

    const tileValues = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-command-center-telemetry-"][data-testid$="-value"]') ?? [],
    );
    expect(tileValues.length).toBeGreaterThan(0);
    for (const node of tileValues) {
      expect(node.textContent?.trim()).toBe("·");
    }
  });
});
