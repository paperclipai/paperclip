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
import type { BlueprintCatalogDetail } from "@/api/blueprints";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const getMock = vi.fn<(companyId: string, ref: string) => Promise<BlueprintCatalogDetail>>();

vi.mock("@/api/blueprints", () => ({
  blueprintsApi: {
    list: vi.fn(),
    get: (companyId: string, ref: string) => getMock(companyId, ref),
  },
}));

import { BlueprintDetailPage, resolveActiveTab } from "./BlueprintDetailPage";

function makeDetail(overrides: Partial<BlueprintCatalogDetail> = {}): BlueprintCatalogDetail {
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
    requiredSecretInputs: overrides.requiredSecretInputs ?? ["ANTHROPIC_API_KEY"],
    requiredProviderKeys: overrides.requiredProviderKeys ?? ["ANTHROPIC_API_KEY"],
    permissionPolicies:
      overrides.permissionPolicies ?? [{ key: "repo.write", gate: "lead", reason: "Writes code." }],
    runtimeDefaults: overrides.runtimeDefaults ?? { adapter: "claude", modelProfile: "strong" },
    budget: overrides.budget ?? { maxRunsPerDay: 12, maxSpendCentsPerDay: 2500 },
    validationContract: overrides.validationContract ?? ["RED test recorded", "Targeted tests pass"],
    systemPromptTemplate:
      overrides.systemPromptTemplate ?? "You are a code implementer. Use TDD.",
    configSchema:
      overrides.configSchema ?? {
        version: 1,
        fields: [
          { key: "displayName", label: "Display name", type: "string", required: false },
        ],
      },
    source: overrides.source ?? { kind: "ready_agent_pool", key: "code-implementer" },
  };
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  getMock.mockReset();
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

async function renderDetail(initialPath: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/eaos/blueprints/:blueprintRef" element={<BlueprintDetailPage />} />
            <Route
              path="/eaos/blueprints/:blueprintRef/capabilities"
              element={<BlueprintDetailPage />}
            />
            <Route
              path="/eaos/blueprints/:blueprintRef/versions/:version"
              element={<BlueprintDetailPage />}
            />
            <Route
              path="/eaos/blueprints/:blueprintRef/instances"
              element={<BlueprintDetailPage />}
            />
            <Route
              path="/eaos/blueprints/:blueprintRef/audit"
              element={<BlueprintDetailPage />}
            />
            <Route path="/eaos/blueprints" element={<div data-testid="catalog-stub" />} />
            <Route path="/eaos/approvals" element={<div data-testid="approvals-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("resolveActiveTab", () => {
  it.each([
    ["/eaos/blueprints/code-implementer@1", "overview"],
    ["/eaos/blueprints/code-implementer@1/", "overview"],
    ["/eaos/blueprints/code-implementer@1/capabilities", "capabilities"],
    ["/eaos/blueprints/code-implementer@1/versions/1", "versions"],
    ["/eaos/blueprints/code-implementer@1/instances", "instances"],
    ["/eaos/blueprints/code-implementer@1/audit", "audit"],
  ])("derives the active tab from %s", (pathname, expected) => {
    expect(resolveActiveTab(pathname)).toBe(expected);
  });
});

describe("BlueprintDetailPage (LET-501 C)", () => {
  it("renders the loading state while the detail request is pending", async () => {
    let resolve: (value: BlueprintCatalogDetail) => void = () => {};
    getMock.mockReturnValueOnce(
      new Promise<BlueprintCatalogDetail>((res) => {
        resolve = res;
      }),
    );
    await renderDetail("/eaos/blueprints/code-implementer@1");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-loading"]'),
      ).not.toBeNull();
    });
    await act(async () => {
      resolve(makeDetail());
    });
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-overview"]'),
      ).not.toBeNull();
    });
  });

  it("renders the not-found state when the detail request 404s", async () => {
    getMock.mockRejectedValue(new Error("not found"));
    await renderDetail("/eaos/blueprints/code-implementer@1");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-error"]'),
      ).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-blueprint-detail-overview"]')).toBeNull();
  });

  it("renders the Overview tab by default with no internal posture chip", async () => {
    getMock.mockResolvedValue(makeDetail());
    await renderDetail("/eaos/blueprints/code-implementer@1");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-overview"]'),
      ).not.toBeNull();
    });
    const posture = container?.querySelector(
      '[data-testid="eaos-blueprint-detail-posture"]',
    );
    expect(posture).toBeNull();
    const tabpanel = container?.querySelector('[data-testid="eaos-blueprint-detail-tabpanel"]');
    expect(tabpanel?.getAttribute("data-tab")).toBe("overview");
  });

  it("renders the Versions tab on /versions/:version with the canonical row and a deferred-history note", async () => {
    getMock.mockResolvedValue(makeDetail({ version: "1" }));
    await renderDetail("/eaos/blueprints/code-implementer@1/versions/1");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-versions"]'),
      ).not.toBeNull();
    });
    const row = container?.querySelector(
      '[data-testid="eaos-blueprint-detail-version-row"]',
    );
    expect(row?.getAttribute("data-version")).toBe("1");
    expect(
      container?.querySelector('[data-testid="eaos-blueprint-detail-version-not-found"]'),
    ).toBeNull();
  });

  it("renders a no-match version state when the URL version does not exist", async () => {
    getMock.mockResolvedValue(makeDetail({ version: "1" }));
    await renderDetail("/eaos/blueprints/code-implementer@1/versions/9");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-version-not-found"]'),
      ).not.toBeNull();
    });
  });

  it("renders the Instances tab as a truthful empty state on /instances", async () => {
    getMock.mockResolvedValue(makeDetail());
    await renderDetail("/eaos/blueprints/code-implementer@1/instances");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-instances-empty"]'),
      ).not.toBeNull();
    });
    // No invented instance rows.
    expect(container?.querySelectorAll('[data-testid="eaos-blueprint-detail-instance-row"]').length).toBe(0);
  });

  it("renders the Capabilities tab panel on /capabilities and the tab href is distinct", async () => {
    getMock.mockResolvedValue(makeDetail());
    await renderDetail("/eaos/blueprints/code-implementer@1/capabilities");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-capabilities"]'),
      ).not.toBeNull();
    });
    const tabpanel = container?.querySelector('[data-testid="eaos-blueprint-detail-tabpanel"]');
    expect(tabpanel?.getAttribute("data-tab")).toBe("capabilities");
    // The Capabilities tab link must point to its own canonical path, not the
    // detail base route, so it is independently reachable.
    const tab = container?.querySelector('[data-testid="eaos-blueprint-detail-tab-capabilities"]');
    expect(tab?.getAttribute("href")).toBe("/eaos/blueprints/code-implementer%401/capabilities");
  });

  it("renders the Audit tab as a truthful empty state on /audit and the tab href is distinct", async () => {
    getMock.mockResolvedValue(makeDetail());
    await renderDetail("/eaos/blueprints/code-implementer@1/audit");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-audit-empty"]'),
      ).not.toBeNull();
    });
    const tabpanel = container?.querySelector('[data-testid="eaos-blueprint-detail-tabpanel"]');
    expect(tabpanel?.getAttribute("data-tab")).toBe("audit");
    const tab = container?.querySelector('[data-testid="eaos-blueprint-detail-tab-audit"]');
    expect(tab?.getAttribute("href")).toBe("/eaos/blueprints/code-implementer%401/audit");
  });

  it("exposes a distinct href for every detail tab from the Overview route", async () => {
    getMock.mockResolvedValue(makeDetail());
    await renderDetail("/eaos/blueprints/code-implementer@1");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-overview"]'),
      ).not.toBeNull();
    });
    const overviewHref = container
      ?.querySelector('[data-testid="eaos-blueprint-detail-tab-overview"]')
      ?.getAttribute("href");
    const capabilitiesHref = container
      ?.querySelector('[data-testid="eaos-blueprint-detail-tab-capabilities"]')
      ?.getAttribute("href");
    const versionsHref = container
      ?.querySelector('[data-testid="eaos-blueprint-detail-tab-versions"]')
      ?.getAttribute("href");
    const instancesHref = container
      ?.querySelector('[data-testid="eaos-blueprint-detail-tab-instances"]')
      ?.getAttribute("href");
    const auditHref = container
      ?.querySelector('[data-testid="eaos-blueprint-detail-tab-audit"]')
      ?.getAttribute("href");
    const hrefs = [overviewHref, capabilitiesHref, versionsHref, instancesHref, auditHref];
    for (const href of hrefs) {
      expect(href).toBeTruthy();
    }
    // Every tab must be a unique URL so operators can land on each panel.
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("redacts secret-shaped strings everywhere on the detail surface", async () => {
    getMock.mockResolvedValue(
      makeDetail({
        title: "Implementer ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII",
        description:
          "Builds features. Authorization=ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII",
        systemPromptTemplate:
          "Bearer ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII writes code.",
        validationContract: [
          "Never leak ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII into telemetry",
        ],
        permissionPolicies: [
          {
            key: "repo.write",
            gate: "lead",
            reason: "Writes code; never echoes sk-ABCDEFGHIJKLMNOPQRSTUV credentials",
          },
        ],
      }),
    );
    await renderDetail("/eaos/blueprints/code-implementer@1");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-overview"]'),
      ).not.toBeNull();
    });
    const text = container?.textContent ?? "";
    expect(text).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
    expect(text).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
    // Walk every element and every non-href attribute — covers data-* and
    // class/title surfaces. The `href` attribute is excluded because the
    // detail tab hrefs use the route key (encodeURIComponent(blueprintRef))
    // which is intentionally not redacted; QA explicitly excluded the
    // route href from the redaction blocker.
    const allElements = Array.from(container?.querySelectorAll("*") ?? []);
    for (const el of allElements) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name === "href") continue;
        expect(attr.value).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
        expect(attr.value).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
      }
    }
  });

  it("redacts credential-shaped values in identifier-style backend fields (ref/key/source/policy/config) — innerHTML and attributes", async () => {
    // Defensive contract: the operator-facing detail surface must never emit
    // a credential-shaped value through any user-visible backend string, even
    // identifier-style fields, and must not leak it through DOM data
    // attributes either. This pins the PR-body claim that all user-visible
    // backend strings flow through redactSecretLikeText.
    getMock.mockResolvedValue(
      makeDetail({
        ref: "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII@1",
        key: "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII",
        version: "sk-ABCDEFGHIJKLMNOPQRSTUV",
        source: { kind: "ready_agent_pool", key: "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII" },
        permissionPolicies: [
          {
            key: "sk-ABCDEFGHIJKLMNOPQRSTUV",
            gate: "lead",
            reason: "n/a",
          },
        ],
        requiredSkillRefs: ["ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII"],
        requiredProviderKeys: ["sk-ABCDEFGHIJKLMNOPQRSTUV"],
        configSchema: {
          version: 1,
          fields: [
            {
              key: "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII",
              label: "Display name",
              type: "string",
              required: false,
            },
          ],
        },
      }),
    );
    await renderDetail("/eaos/blueprints/code-implementer@1/capabilities");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-capabilities"]'),
      ).not.toBeNull();
    });
    // Visible text must never carry the raw sentinel.
    const text = container?.textContent ?? "";
    expect(text).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
    expect(text).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
    // Walk every element and every non-href attribute — covers data-*,
    // class, title, etc. The `href` attribute is excluded because the
    // detail tab hrefs use the route key (encodeURIComponent(blueprintRef))
    // which is intentionally not redacted; QA explicitly excluded the
    // route href from the redaction blocker.
    const allElements = Array.from(container?.querySelectorAll("*") ?? []);
    for (const el of allElements) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name === "href") continue;
        expect(attr.value).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
        expect(attr.value).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
      }
    }
    // Spot-check the named identifier attributes flagged in the QA verdict.
    const page = container?.querySelector('[data-testid="eaos-blueprint-detail-page"]');
    expect(page?.getAttribute("data-blueprint-ref")).not.toContain(
      "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII",
    );
    const policyLi = container?.querySelector(
      '[data-testid="eaos-blueprint-detail-permissions"] li',
    );
    expect(policyLi?.getAttribute("data-policy-key")).not.toContain(
      "sk-ABCDEFGHIJKLMNOPQRSTUV",
    );
  });

  it("redacts credential-shaped version in DOM attributes on the Versions tab", async () => {
    getMock.mockResolvedValue(
      makeDetail({ version: "sk-ABCDEFGHIJKLMNOPQRSTUV" }),
    );
    await renderDetail("/eaos/blueprints/code-implementer@1/versions/latest");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-versions"]'),
      ).not.toBeNull();
    });
    const row = container?.querySelector(
      '[data-testid="eaos-blueprint-detail-version-row"]',
    );
    expect(row?.getAttribute("data-version")).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
    const html = container?.innerHTML ?? "";
    expect(html).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("does not render any mutating buttons on the operator detail path", async () => {
    getMock.mockResolvedValue(makeDetail());
    await renderDetail("/eaos/blueprints/code-implementer@1");
    await waitFor(() => {
      expect(
        container?.querySelector('[data-testid="eaos-blueprint-detail-overview"]'),
      ).not.toBeNull();
    });
    const buttons = container?.querySelectorAll("button");
    expect(buttons?.length ?? 0).toBe(0);
    // Anchors must only navigate within /eaos (catalog / detail tabs /
    // approvals link) — never to instantiate / publish / deprecate /
    // restart endpoints.
    const anchors = Array.from(container?.querySelectorAll("a") ?? []);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href).toMatch(/^\/eaos(?:$|\/)/);
      expect(href).not.toMatch(/instantiate|publish|deprecate|restart|deploy/i);
    }
  });
});
