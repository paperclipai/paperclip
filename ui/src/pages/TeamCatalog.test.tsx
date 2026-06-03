// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CatalogTeam,
  CatalogTeamImportPreviewResult,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamCatalog } from "./TeamCatalog";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockTeamCatalogApi = vi.hoisted(() => ({
  catalogList: vi.fn(),
  catalogDetail: vi.fn(),
  catalogFile: vi.fn(),
  preview: vi.fn(),
  install: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../api/teamCatalog", () => ({ teamCatalogApi: mockTeamCatalogApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// Drive the route deterministically: the team is preselected so the detail pane
// renders without depending on the auto-select navigation effect.
let currentRoute = "team-no-deps";
const mockSearchParams = new URLSearchParams();
vi.mock("@/lib/router", () => ({
  useParams: () => ({ "*": currentRoute }),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams, vi.fn()],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// cmdk (Command) and Radix rely on browser APIs jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;
// jsdom has no matchMedia. Default to desktop (min-width queries match, max-width don't).
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: /min-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeTeam(overrides: Partial<CatalogTeam> = {}): CatalogTeam {
  return {
    id: "team-no-deps",
    key: "paperclipai/bundled/company-defaults/team-no-deps",
    kind: "bundled",
    category: "company-defaults",
    slug: "team-no-deps",
    name: "Core Exec Team",
    description: "A starter executive team.",
    path: "catalog/bundled/company-defaults/team-no-deps",
    entrypoint: "TEAM.md",
    schema: "agentcompanies/v1",
    defaultInstall: true,
    recommendedForCompanyTypes: [],
    tags: ["exec"],
    counts: {
      agents: 2,
      projects: 1,
      tasks: 0,
      routines: 1,
      localSkills: 0,
      catalogSkills: 0,
      externalSkillSources: 0,
    },
    rootAgentSlugs: [],
    agentSlugs: ["ceo", "cto"],
    projectSlugs: ["launch"],
    requiredSkills: [],
    envInputs: [],
    sourceRefs: [],
    files: [{ path: "TEAM.md", kind: "team", sizeBytes: 100, sha256: "abc" }],
    trustLevel: "markdown_only",
    compatibility: "compatible",
    contentHash: "sha256:deadbeefdeadbeefdeadbeef",
    ...overrides,
  };
}

function makePreview(): CatalogTeamImportPreviewResult {
  return {
    team: makeTeam(),
    portabilityPreview: {
      include: { company: false, agents: true, projects: true, issues: false, skills: true },
      targetCompanyId: "company-1",
      targetCompanyName: "Paperclip",
      collisionStrategy: "rename",
      selectedAgentSlugs: ["ceo", "cto"],
      plan: {
        companyAction: "none",
        agentPlans: [
          { slug: "ceo", action: "create", plannedName: "CEO", existingAgentId: null, reason: null },
          { slug: "cto", action: "create", plannedName: "CTO", existingAgentId: null, reason: null },
        ],
        projectPlans: [
          { slug: "launch", action: "create", plannedName: "Launch", existingProjectId: null, reason: null },
        ],
        issuePlans: [],
      },
      manifest: {
        schemaVersion: 1,
        generatedAt: "2026-06-03T00:00:00.000Z",
        source: null,
        includes: { company: false, agents: true, projects: true, issues: false, skills: true },
        company: null,
        sidebar: null,
        agents: [],
        skills: [],
        projects: [],
        issues: [],
        envInputs: [],
      },
      files: {},
      envInputs: [],
      warnings: [],
      errors: [],
    },
    skillPreparations: [],
    warnings: [],
    errors: [],
  };
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  ) as HTMLButtonElement | undefined;
}

describe("TeamCatalog install preview path", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentRoute = "team-no-deps";
    mockAgentsApi.list.mockResolvedValue([]);
    mockTeamCatalogApi.catalogList.mockResolvedValue([makeTeam()]);
    mockTeamCatalogApi.preview.mockResolvedValue(makePreview());
    mockTeamCatalogApi.install.mockResolvedValue({
      team: makeTeam(),
      portabilityImport: {
        company: { id: "company-1", name: "Paperclip", action: "unchanged" },
        agents: [],
        projects: [],
        envInputs: [],
        warnings: [],
      },
      skillPreparations: [],
      warnings: [],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <TeamCatalog />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("renders the detail pane for the selected team", async () => {
    await renderPage();
    expect(document.body.textContent).toContain("Core Exec Team");
    expect(document.body.textContent).toContain("A starter executive team.");
    // summary grid counts
    expect(document.body.textContent).toContain("Agents");
    expect(document.body.textContent).toContain("Projects");
  });

  it("opens the installer, fetches the preview, and submits the install", async () => {
    await renderPage();

    // Open the installer from the detail CTA.
    const installCta = findButton("Install team");
    expect(installCta).toBeTruthy();
    await act(async () => {
      installCta!.click();
    });
    await flushReact();

    // The wizard is single-step (no deps) → lands on the preview step and
    // auto-loads the categorized preview.
    expect(mockTeamCatalogApi.preview).toHaveBeenCalledTimes(1);
    expect(mockTeamCatalogApi.preview).toHaveBeenCalledWith(
      "company-1",
      "team-no-deps",
      expect.objectContaining({ collisionStrategy: "rename" }),
    );
    expect(document.body.textContent).toContain("Summary");
    // categorized plan rows
    expect(document.body.textContent?.toLowerCase()).toContain("ceo");
    expect(document.body.textContent?.toLowerCase()).toContain("launch");

    // Submit install from the footer.
    const submit = Array.from(document.querySelectorAll("button")).filter((b) =>
      (b.textContent ?? "").includes("Install team"),
    );
    // Last "Install team" is the wizard footer submit.
    await act(async () => {
      submit[submit.length - 1].click();
    });
    await flushReact();

    expect(mockTeamCatalogApi.install).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Team installed");
  });

  it("requires a target manager before continuing when the team has root agents", async () => {
    currentRoute = "team-with-root";
    mockTeamCatalogApi.catalogList.mockResolvedValue([
      makeTeam({ id: "team-with-root", slug: "team-with-root", rootAgentSlugs: ["ceo"], agentSlugs: ["ceo", "cto"] }),
    ]);
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Founder",
        urlKey: "founder",
        role: "ceo",
        title: null,
        icon: null,
        status: "active",
        reportsTo: null,
        capabilities: null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        pauseReason: null,
        pausedAt: null,
        permissions: {},
        lastHeartbeatAt: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await renderPage();

    const installCta = findButton("Install team");
    await act(async () => {
      installCta!.click();
    });
    await flushReact();

    // First step is target manager; Continue is disabled until a manager is chosen.
    expect(document.body.textContent).toContain("root agents need a manager");
    const continueBtn = findButton("Continue");
    expect(continueBtn).toBeTruthy();
    expect(continueBtn!.disabled).toBe(true);
    // Preview has not been requested yet (still on step 1).
    expect(mockTeamCatalogApi.preview).not.toHaveBeenCalled();
  });
});
