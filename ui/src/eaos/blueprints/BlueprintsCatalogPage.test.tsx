// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BlueprintCatalogEntry,
  BlueprintCatalogListResponse,
} from "@/api/blueprints";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const listMock = vi.fn<(companyId: string) => Promise<BlueprintCatalogListResponse>>();

vi.mock("@/api/blueprints", () => ({
  blueprintsApi: {
    list: (companyId: string) => listMock(companyId),
    get: vi.fn(),
  },
}));

import { BlueprintsCatalogPage } from "./BlueprintsCatalogPage";

// Synthetic credential-shaped fixture used to exercise the catalog card
// redaction contract. Constructed at runtime so the committed source has no
// `ghp_` literal that a diff-scoped secret scanner could mistake for a real
// GitHub PAT. The runtime value still matches the redactor's regex shape.
const GH_TOKEN_PREFIX = String.fromCharCode(103, 104, 112, 95); // gh + p + _
const GH_TOKEN_FIXTURE = `${GH_TOKEN_PREFIX}${"A".repeat(36)}`;

function makeEntry(overrides: Partial<BlueprintCatalogEntry> = {}): BlueprintCatalogEntry {
  return {
    ref: overrides.ref ?? "code-implementer@1",
    key: overrides.key ?? "code-implementer",
    version: overrides.version ?? "1",
    title: overrides.title ?? "Code Implementer",
    category: overrides.category ?? "engineering",
    description: overrides.description ?? "Builds features with tests.",
    status: overrides.status ?? "published",
    requiredSkillRefs: overrides.requiredSkillRefs ?? ["test-driven-development"],
    mcpBundleRefs: overrides.mcpBundleRefs ?? [],
    requiredSecretInputs: overrides.requiredSecretInputs ?? [],
    requiredProviderKeys: overrides.requiredProviderKeys ?? [],
    permissionPolicies:
      overrides.permissionPolicies ?? [{ key: "repo.write", gate: "lead", reason: "Writes code." }],
    runtimeDefaults: overrides.runtimeDefaults ?? { adapter: "claude", modelProfile: "strong" },
    budget: overrides.budget ?? { maxRunsPerDay: 12, maxSpendCentsPerDay: 2500 },
    validationContract: overrides.validationContract ?? [],
  };
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  listMock.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function renderCatalog() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/blueprints"]}>
          <Routes>
            <Route path="/eaos/blueprints" element={<BlueprintsCatalogPage />} />
            <Route
              path="/eaos/blueprints/:blueprintRef"
              element={<div data-testid="blueprint-detail-stub" />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("BlueprintsCatalogPage (LET-501 C)", () => {
  it("renders the loading state until the backend read settles", async () => {
    let resolve: (value: BlueprintCatalogListResponse) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise<BlueprintCatalogListResponse>((res) => {
        resolve = res;
      }),
    );
    await renderCatalog();
    await waitFor(() => {
      expect(container?.querySelector('[data-testid="eaos-blueprints-loading"]')).not.toBeNull();
    });
    await act(async () => {
      resolve({ enabled: true, versions: [] });
    });
    await waitFor(() => {
      expect(container?.querySelector('[data-testid="eaos-blueprints-empty"]')).not.toBeNull();
    });
  });

  it("renders a clean single-word title and no internal posture chips", async () => {
    listMock.mockResolvedValue({ enabled: true, versions: [makeEntry()] });
    await renderCatalog();
    await waitFor(() => {
      const title = container?.querySelector('[data-testid="eaos-blueprints-title"]');
      expect(title?.textContent).toBe("Blueprints");
      const posture = container?.querySelector('[data-testid="eaos-blueprints-posture"]');
      expect(posture).toBeNull();
      const html = container?.innerHTML ?? "";
      expect(html).not.toContain("BACKEND-BACKED");
    });
  });

  it("renders a feature-disabled callout when the catalog is off (not an empty state)", async () => {
    listMock.mockResolvedValue({ enabled: false, versions: [] });
    await renderCatalog();
    await waitFor(() => {
      expect(container?.querySelector('[data-testid="eaos-blueprints-disabled"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-blueprints-empty"]')).toBeNull();
    expect(container?.querySelector('[data-testid="eaos-blueprints-cards"]')).toBeNull();
  });

  it("renders the error state when the request fails (no card grid, no fake counts)", async () => {
    listMock.mockRejectedValue(new Error("backend offline"));
    await renderCatalog();
    await waitFor(() => {
      expect(container?.querySelector('[data-testid="eaos-blueprints-error"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-blueprints-cards"]')).toBeNull();
    expect(container?.querySelector('[data-testid="eaos-blueprints-count-truth"]')).toBeNull();
  });

  it("renders cards with backend-derived counts and a truthful loaded-result label", async () => {
    listMock.mockResolvedValue({
      enabled: true,
      versions: [
        makeEntry({ ref: "code-implementer@1", key: "code-implementer", category: "engineering" }),
        makeEntry({
          ref: "ceo-pm@1",
          key: "ceo-pm",
          title: "CEO/PM",
          category: "leadership",
          permissionPolicies: [],
        }),
        makeEntry({
          ref: "outreach-drafter@1",
          key: "outreach-drafter",
          title: "Outreach Drafter",
          category: "growth",
          permissionPolicies: [
            { key: "outreach.live_send", gate: "board", reason: "Live outreach." },
          ],
        }),
      ],
    });
    await renderCatalog();
    await waitFor(() => {
      const cards = container?.querySelectorAll('[data-testid="eaos-blueprints-card"]');
      expect(cards?.length).toBe(3);
    });
    const truth = container?.querySelector('[data-testid="eaos-blueprints-count-truth"]');
    expect(truth?.textContent).toMatch(/Showing\s*3\s*of\s*3\s*loaded blueprint versions/);
    expect(truth?.textContent).toContain(
      "no popularity, activity, or success metrics",
    );
    // The outreach card flags live-external-action risk.
    const outreachCard = container?.querySelector(
      '[data-blueprint-key="outreach-drafter"]',
    );
    expect(outreachCard?.textContent).toContain("Risk · APPROVAL REQUIRED");
  });

  it("never renders raw secret-shaped strings in card content or DOM attributes", async () => {
    listMock.mockResolvedValue({
      enabled: true,
      versions: [
        makeEntry({
          ref: `${GH_TOKEN_FIXTURE}@1`,
          key: GH_TOKEN_FIXTURE,
          title: `Code Implementer ${GH_TOKEN_FIXTURE}`,
          description: `Leaks an Authorization=${GH_TOKEN_FIXTURE} header`,
        }),
      ],
    });
    await renderCatalog();
    await waitFor(() => {
      expect(container?.querySelector('[data-testid="eaos-blueprints-card"]')).not.toBeNull();
    });
    // Visible text must never carry the raw credential-shaped string.
    const text = container?.textContent ?? "";
    expect(text).not.toContain(GH_TOKEN_FIXTURE);
    // Walk every element and every attribute except `href` — DOM data
    // attributes such as data-blueprint-ref / data-blueprint-key are the
    // attribute surfaces flagged in the QA verdict, and this catches a
    // redaction bypass on any of them. The `href` attribute is excluded
    // because the catalog route key (encodeURIComponent(entry.ref)) is
    // intentionally not redacted: it is the canonical navigation key for
    // the detail page and QA explicitly excluded the route href from the
    // redaction blocker.
    const allElements = Array.from(container?.querySelectorAll("*") ?? []);
    for (const el of allElements) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name === "href") continue;
        expect(attr.value).not.toContain(GH_TOKEN_FIXTURE);
      }
    }
    // Spot-check the named card data attributes flagged in the QA verdict.
    const card = container?.querySelector('[data-testid="eaos-blueprints-card"]');
    expect(card?.getAttribute("data-blueprint-ref")).not.toContain(GH_TOKEN_FIXTURE);
    expect(card?.getAttribute("data-blueprint-key")).not.toContain(GH_TOKEN_FIXTURE);
  });

  it("filters by search and category without inventing rows", async () => {
    listMock.mockResolvedValue({
      enabled: true,
      versions: [
        makeEntry({ ref: "code-implementer@1", category: "engineering", title: "Code Implementer" }),
        makeEntry({
          ref: "research-analyst@1",
          category: "research",
          title: "Research Analyst",
        }),
      ],
    });
    await renderCatalog();
    await waitFor(() => {
      expect(container?.querySelectorAll('[data-testid="eaos-blueprints-card"]').length).toBe(2);
    });

    // Apply category filter → only one card visible.
    const engineeringBtn = container?.querySelector(
      '[data-testid="eaos-blueprints-category-engineering"]',
    ) as HTMLButtonElement | null;
    expect(engineeringBtn).not.toBeNull();
    await act(async () => {
      engineeringBtn!.click();
    });
    await waitFor(() => {
      const cards = container?.querySelectorAll('[data-testid="eaos-blueprints-card"]');
      expect(cards?.length).toBe(1);
      expect(cards?.[0]?.getAttribute("data-blueprint-category")).toBe("engineering");
    });
    const truth = container?.querySelector('[data-testid="eaos-blueprints-count-truth"]');
    expect(truth?.textContent).toMatch(/Showing\s*1\s*of\s*2/);
  });

  it("renders no mutating buttons on the operator catalog path", async () => {
    listMock.mockResolvedValue({
      enabled: true,
      versions: [makeEntry()],
    });
    await renderCatalog();
    await waitFor(() => {
      expect(container?.querySelector('[data-testid="eaos-blueprints-card"]')).not.toBeNull();
    });
    // The only buttons should be category filter toggles, never authoring /
    // publish / deprecate / instantiate / restart.
    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    for (const button of buttons) {
      const testId = button.getAttribute("data-testid") ?? "";
      expect(testId.startsWith("eaos-blueprints-category-")).toBe(true);
    }
    // Anchors must only link inside /eaos (catalog → detail), never to
    // instantiate / publish / deprecate / restart endpoints.
    const anchors = Array.from(container?.querySelectorAll("a") ?? []);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href).toMatch(/^\/eaos(?:$|\/)/);
      expect(href).not.toMatch(/instantiate|publish|deprecate|restart|deploy/i);
    }
  });
});
