// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySkillListItem } from "@paperclipai/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const skillsListMock = vi.fn<(companyId: string) => Promise<CompanySkillListItem[]>>();

vi.mock("@/api/companySkills", () => ({
  companySkillsApi: {
    list: (companyId: string) => skillsListMock(companyId),
  },
}));

import { KnowledgePage } from "./KnowledgePage";

function makeSkill(overrides: Partial<CompanySkillListItem> & { id: string; name: string }): CompanySkillListItem {
  return {
    id: overrides.id,
    companyId: "company-1",
    key: overrides.key ?? overrides.id,
    slug: overrides.slug ?? overrides.id,
    name: overrides.name,
    description: overrides.description ?? null,
    sourceType: overrides.sourceType ?? "local",
    sourceLocator: overrides.sourceLocator ?? null,
    sourceRef: overrides.sourceRef ?? null,
    trustLevel: overrides.trustLevel ?? "trusted",
    compatibility: overrides.compatibility ?? ({} as CompanySkillListItem["compatibility"]),
    fileInventory: overrides.fileInventory ?? [],
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    attachedAgentCount: overrides.attachedAgentCount ?? 0,
    editable: overrides.editable ?? true,
    editableReason: overrides.editableReason ?? null,
    sourceLabel: overrides.sourceLabel ?? null,
    sourceBadge: overrides.sourceBadge ?? ({} as CompanySkillListItem["sourceBadge"]),
    sourcePath: overrides.sourcePath ?? null,
  } as CompanySkillListItem;
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  skillsListMock.mockReset();
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

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 30) {
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

async function renderKnowledge() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/knowledge"]}>
          <Routes>
            <Route path="/eaos/knowledge" element={<KnowledgePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("KnowledgePage (LET-484 working-product slice)", () => {
  it("renders the knowledge surface (not the EaosZonePlaceholder)", async () => {
    skillsListMock.mockResolvedValue([]);
    await renderKnowledge();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-knowledge-page"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();
  });

  it("labels playbooks as backend-backed once the live read resolves", async () => {
    skillsListMock.mockResolvedValue([
      makeSkill({ id: "s-1", name: "Frontend QA playbook" }),
    ]);
    await renderKnowledge();
    await waitForMicrotaskAssertion(() => {
      const posture = container?.querySelector('[data-testid="eaos-knowledge-posture"]');
      const text = posture?.textContent ?? "";
      expect(text).toContain("Shell · BACKEND-BACKED");
      expect(text).toContain("Playbooks · BACKEND-BACKED");
      // Cross-mission search gap stays truthful, in customer-friendly copy.
      expect(text).toContain("Cross-mission search · PREVIEW");
    });
  });

  it("renders skill rows + names the unwired KB index gap as a truthful temporary gap", async () => {
    skillsListMock.mockResolvedValue([
      makeSkill({ id: "s-1", name: "Frontend QA playbook", description: "Browser smoke flows" }),
      makeSkill({ id: "s-2", name: "Approvals SOP", attachedAgentCount: 3 }),
    ]);
    await renderKnowledge();
    await waitForMicrotaskAssertion(() => {
      const rows = container?.querySelectorAll('[data-testid="eaos-knowledge-playbook-row"]');
      expect(rows?.length).toBe(2);
      expect(rows?.[0].querySelector('[data-testid="eaos-knowledge-playbook-name"]')?.textContent).toContain(
        "Frontend QA playbook",
      );
      const gap = container?.querySelector('[data-testid="eaos-knowledge-kb-index-gap"]');
      const gapText = gap?.textContent ?? "";
      expect(gapText).toContain("Temporary gap");
      expect(gapText).toContain("GET /api/companies/:companyId/knowledge");
    });
  });

  it("links to /eaos/missions for per-mission document/evidence index", async () => {
    skillsListMock.mockResolvedValue([]);
    await renderKnowledge();
    await waitForMicrotaskAssertion(() => {
      const link = container?.querySelector('[data-testid="eaos-knowledge-missions-link"]');
      expect(link?.getAttribute("href")).toBe("/eaos/missions");
    });
  });

  it("does NOT render any live action buttons", async () => {
    skillsListMock.mockResolvedValue([makeSkill({ id: "s-1", name: "Pack" })]);
    await renderKnowledge();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-knowledge-playbook-row"]')).not.toBeNull();
    });
    expect(container?.querySelectorAll("button").length).toBe(0);
  });
});
