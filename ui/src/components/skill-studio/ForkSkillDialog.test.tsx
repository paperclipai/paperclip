// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CompanySkillDetail,
  CompanySkillForkPrecheckResult,
  CompanySkillForkSummary,
  CompanySkillUsageAgent,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForkSkillDialog } from "./ForkSkillDialog";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockCompanySkillsApi = vi.hoisted(() => ({
  fork: vi.fn(),
  forkPrecheck: vi.fn(),
  detail: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mockNavigate,
}));
vi.mock("@/api/companySkills", () => ({ companySkillsApi: mockCompanySkillsApi }));
vi.mock("@/context/ToastContext", () => ({
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

// React's `act` is not usable in this vitest setup; drive updates via flushSync
// like SkillStudio.test.tsx / AgentsUsingSkillDialog.test.tsx do.
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function teardown() {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
}

async function renderNode(node: ReactNode) {
  teardown();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  await flush();
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function findButton(match: (text: string) => boolean): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find((button) =>
    match(button.textContent?.trim() ?? ""),
  ) as HTMLButtonElement | undefined;
  if (!found) throw new Error("button not found");
  return found;
}

function makeAgent(over: Partial<CompanySkillUsageAgent> = {}): CompanySkillUsageAgent {
  return {
    id: "agent-1",
    name: "Reviewer",
    urlKey: "reviewer",
    adapterType: "claude_local",
    desired: true,
    actualState: null,
    versionId: null,
    ...over,
  };
}

function makeSkill(over: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "skill-1",
    companyId: "company-1",
    key: "github/anthropics/skills",
    slug: "deep-research",
    name: "Deep Research",
    description: null,
    markdown: "",
    sourceType: "github",
    sourceLocator: "https://github.com/anthropics/skills",
    sourceRef: "0123456789abcdef0123456789abcdef01234567",
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [],
    iconUrl: null,
    color: null,
    tagline: null,
    authorName: null,
    homepageUrl: null,
    categories: [],
    sharingScope: "company",
    publicShareToken: null,
    forkedFromSkillId: null,
    forkedFromCompanyId: null,
    starCount: 0,
    installCount: 0,
    forkCount: 0,
    currentVersionId: "ver-1",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: false,
    editableReason: "This skill comes from GitHub and is read-only.",
    sourceLabel: "GitHub",
    sourceBadge: "github",
    sourcePath: null,
    currentVersion: null,
    starredByCurrentActor: false,
    existingForks: [],
    ...over,
  };
}

function makePrecheck(over: Partial<CompanySkillForkPrecheckResult> = {}): CompanySkillForkPrecheckResult {
  return {
    skillId: "skill-1",
    original: {
      id: "skill-1",
      name: "Deep Research",
      slug: "deep-research",
      sourceType: "github",
      sourceLocator: "https://github.com/anthropics/skills",
      sourceRef: "0123456789abcdef0123456789abcdef01234567",
    },
    agentUsageCount: 0,
    usedByAgents: [],
    existingForks: [],
    ...over,
  };
}

function makeForkSummary(over: Partial<CompanySkillForkSummary> = {}): CompanySkillForkSummary {
  return {
    id: "fork-existing",
    name: "Deep Research (copy)",
    slug: "deep-research-fork",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    key: "company/deep-research-fork",
    forkedFromSkillId: "skill-1",
    forkedFromCompanyId: "company-1",
    currentVersionId: "v1",
    createdByCurrentActor: true,
    diverged: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  mockCompanySkillsApi.forkPrecheck.mockResolvedValue(makePrecheck());
  mockCompanySkillsApi.fork.mockResolvedValue({
    skill: { id: "fork-new" },
    original: makePrecheck().original,
    reassignments: [],
  });
  mockCompanySkillsApi.detail.mockResolvedValue(makeSkill());
  mockNavigate.mockReset();
  mockPushToast.mockReset();
});

afterEach(() => {
  teardown();
  vi.clearAllMocks();
});

describe("ForkSkillDialog", () => {
  it("shows the agent count prominently and forks with reassignment ON by default", async () => {
    const agents = [makeAgent({ id: "a1", name: "Reviewer" }), makeAgent({ id: "a2", name: "Planner" })];
    mockCompanySkillsApi.forkPrecheck.mockResolvedValue(
      makePrecheck({ agentUsageCount: 2, usedByAgents: agents }),
    );
    mockCompanySkillsApi.fork.mockResolvedValue({
      skill: { id: "fork-new" },
      original: makePrecheck().original,
      reassignments: [
        { agentId: "a1", previousSkillKey: "k", nextSkillKey: "kf" },
        { agentId: "a2", previousSkillKey: "k", nextSkillKey: "kf" },
      ],
    });

    await renderNode(
      <ForkSkillDialog
        companyId="company-1"
        skill={makeSkill({ usedByAgents: agents, attachedAgentCount: 2 })}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(document.body.textContent).toContain("2 agents currently use this skill");
    expect(document.body.textContent).toContain("Reviewer");
    expect(document.body.textContent).toContain("Planner");

    const confirm = findButton((t) => t.startsWith("Create copy & switch 2 agents"));
    await click(confirm);

    expect(mockCompanySkillsApi.fork).toHaveBeenCalledWith("company-1", "skill-1", {
      reassignAgentIds: ["a1", "a2"],
    });
    expect(mockNavigate).toHaveBeenCalledWith("/skills/studio/fork-new");
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    );
  });

  it("forks with NO reassignment when the toggle is switched off", async () => {
    const agents = [makeAgent({ id: "a1" })];
    mockCompanySkillsApi.forkPrecheck.mockResolvedValue(
      makePrecheck({ agentUsageCount: 1, usedByAgents: agents }),
    );

    await renderNode(
      <ForkSkillDialog
        companyId="company-1"
        skill={makeSkill({ usedByAgents: agents, attachedAgentCount: 1 })}
        open
        onOpenChange={() => {}}
      />,
    );

    const toggle = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch these agents to the copy"]',
    );
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await click(toggle!);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await click(findButton((t) => t === "Create copy"));

    expect(mockCompanySkillsApi.fork).toHaveBeenCalledWith("company-1", "skill-1", {
      reassignAgentIds: [],
    });
  });

  it("offers 'Open your existing copy' when an un-diverged same-actor fork exists", async () => {
    mockCompanySkillsApi.forkPrecheck.mockResolvedValue(
      makePrecheck({ existingForks: [makeForkSummary({ id: "fork-existing" })] }),
    );

    await renderNode(
      <ForkSkillDialog
        companyId="company-1"
        skill={makeSkill({ existingForks: [makeForkSummary({ id: "fork-existing" })] })}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(document.body.textContent).toContain("You already have a copy");
    await click(findButton((t) => t === "Open your existing copy"));
    expect(mockNavigate).toHaveBeenCalledWith("/skills/studio/fork-existing");
    expect(mockCompanySkillsApi.fork).not.toHaveBeenCalled();
  });

  it("hides the toggle and reports zero usage when no agents use the skill", async () => {
    await renderNode(
      <ForkSkillDialog companyId="company-1" skill={makeSkill()} open onOpenChange={() => {}} />,
    );

    expect(document.body.textContent).toContain("No agents currently use this skill");
    expect(
      document.body.querySelector('button[aria-label="Switch these agents to the copy"]'),
    ).toBeNull();
  });
});
