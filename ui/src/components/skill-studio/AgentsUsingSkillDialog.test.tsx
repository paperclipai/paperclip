// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AgentDesiredSkillEntry,
  CompanySkillDetail,
  CompanySkillUsageAgent,
  CompanySkillVersion,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentsUsingSkillBadge,
  AgentsUsingSkillDialog,
} from "./AgentsUsingSkillDialog";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  skills: vi.fn(),
  syncSkills: vi.fn(),
}));
const mockCompanySkillsApi = vi.hoisted(() => ({
  versions: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/companySkills", () => ({ companySkillsApi: mockCompanySkillsApi }));
vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
    supportsModelProfiles: false,
  }),
}));
vi.mock("@/context/ToastContext", () => ({
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

// React's `act` is not usable in this vitest setup (known gotcha); drive
// updates through flushSync like SkillStudio.test.tsx does.
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
  // Radix Dialog portals to document.body; drop any leftovers between renders.
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

function findButton(name: string): HTMLButtonElement {
  const match = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;
  if (!match) throw new Error(`No button labelled "${name}"`);
  return match;
}

function makeAgent(overrides: Partial<CompanySkillUsageAgent> = {}): CompanySkillUsageAgent {
  return {
    id: "agent-1",
    name: "Reviewer",
    urlKey: "reviewer",
    adapterType: "claude_local",
    desired: true,
    actualState: null,
    versionId: null,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<CompanySkillVersion> = {}): CompanySkillVersion {
  return {
    id: "ver-1",
    companyId: "company-1",
    companySkillId: "skill-1",
    revisionNumber: 1,
    label: null,
    fileInventory: [],
    authorAgentId: null,
    authorUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeSkill(overrides: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: "skill-1",
    companyId: "company-1",
    key: "paperclip/demo",
    slug: "demo",
    name: "Demo Skill",
    description: null,
    markdown: "",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
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
    currentVersionId: "ver-3",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: 0,
    usedByAgents: [],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
    currentVersion: makeVersion({ id: "ver-3", revisionNumber: 3 }),
    starredByCurrentActor: false,
    existingForks: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockAgentsApi.list.mockResolvedValue([]);
  mockAgentsApi.skills.mockResolvedValue({
    adapterType: "claude_local",
    supported: true,
    mode: "managed",
    desiredSkills: [],
    desiredSkillEntries: [],
    entries: [],
    warnings: [],
  });
  mockAgentsApi.syncSkills.mockResolvedValue({});
  mockCompanySkillsApi.versions.mockResolvedValue([]);
  mockPushToast.mockReset();
});

afterEach(() => {
  teardown();
  vi.clearAllMocks();
});

describe("AgentsUsingSkillBadge", () => {
  it("renders a muted '0 agents' button with an a11y label when unused", async () => {
    await renderNode(<AgentsUsingSkillBadge companyId="company-1" skill={makeSkill()} />);
    const badge = findButton("0 agents");
    expect(badge).toBeDefined();
    expect(badge?.getAttribute("aria-label")).toBe("0 agents use this skill");
    expect(badge?.className).toContain("text-muted-foreground");
  });

  it("pluralizes and opens the dialog on click", async () => {
    const skill = makeSkill({
      usedByAgents: [makeAgent(), makeAgent({ id: "agent-2", name: "Coder", urlKey: "coder" })],
    });
    await renderNode(<AgentsUsingSkillBadge companyId="company-1" skill={skill} />);
    const badge = findButton("2 agents");
    expect(badge?.getAttribute("aria-label")).toBe("2 agents use this skill");
    await click(badge!);
    expect(document.body.textContent).toContain("Agents using Demo Skill");
    expect(document.body.textContent).toContain("Reviewer");
    expect(document.body.textContent).toContain("Coder");
  });
});

describe("AgentsUsingSkillDialog", () => {
  it("shows a version select with Latest (vN) and a static '—' when no version history", async () => {
    mockCompanySkillsApi.versions.mockResolvedValue([
      makeVersion({ id: "ver-3", revisionNumber: 3 }),
      makeVersion({ id: "ver-2", revisionNumber: 2 }),
    ]);
    const skill = makeSkill({ usedByAgents: [makeAgent()] });
    await renderNode(
      <AgentsUsingSkillDialog open onOpenChange={() => {}} companyId="company-1" skill={skill} />,
    );
    const select = document.body.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.textContent).toContain("Latest (v3)");
    expect(select?.textContent).toContain("v2");

    // No version history → "—" and no select.
    await renderNode(
      <AgentsUsingSkillDialog
        open
        onOpenChange={() => {}}
        companyId="company-1"
        skill={makeSkill({ currentVersion: null, currentVersionId: null, usedByAgents: [makeAgent()] })}
      />,
    );
    // The second render's dialog is the last-opened; its row shows an em dash.
    expect(document.body.textContent).toContain("—");
  });

  it("shows a 'behind latest' hint for a stale pin", async () => {
    mockCompanySkillsApi.versions.mockResolvedValue([
      makeVersion({ id: "ver-3", revisionNumber: 3 }),
      makeVersion({ id: "ver-1", revisionNumber: 1 }),
    ]);
    const skill = makeSkill({ usedByAgents: [makeAgent({ versionId: "ver-1" })] });
    await renderNode(
      <AgentsUsingSkillDialog open onOpenChange={() => {}} companyId="company-1" skill={skill} />,
    );
    expect(document.body.textContent).toContain("2 versions behind latest");
  });

  it("removes via GET-then-sync and preserves the agent's other skills", async () => {
    mockAgentsApi.skills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "managed",
      desiredSkills: ["paperclip/demo", "paperclip/other"],
      desiredSkillEntries: [
        { key: "paperclip/demo", versionId: null },
        { key: "paperclip/other", versionId: null },
      ] satisfies AgentDesiredSkillEntry[],
      entries: [],
      warnings: [],
    });
    const skill = makeSkill({ usedByAgents: [makeAgent()] });
    await renderNode(
      <AgentsUsingSkillDialog open onOpenChange={() => {}} companyId="company-1" skill={skill} />,
    );

    // The trash button has no text; grab it by aria-label.
    const trash = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label^="Remove this skill from"]',
    );
    await click(trash!);
    const confirm = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label^="Confirm removing this skill from"]',
    );
    await click(confirm!);

    expect(mockAgentsApi.skills).toHaveBeenCalledWith("agent-1", "company-1");
    expect(mockAgentsApi.syncSkills).toHaveBeenCalledTimes(1);
    const [, sentEntries] = mockAgentsApi.syncSkills.mock.calls[0];
    expect(sentEntries).toEqual([{ key: "paperclip/other", versionId: null }]);
  });

  it("pins a version by sending the full set with the target repinned", async () => {
    mockCompanySkillsApi.versions.mockResolvedValue([
      makeVersion({ id: "ver-3", revisionNumber: 3 }),
      makeVersion({ id: "ver-2", revisionNumber: 2 }),
    ]);
    mockAgentsApi.skills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "managed",
      desiredSkills: ["paperclip/demo", "paperclip/other"],
      desiredSkillEntries: [
        { key: "paperclip/demo", versionId: null },
        { key: "paperclip/other", versionId: null },
      ] satisfies AgentDesiredSkillEntry[],
      entries: [],
      warnings: [],
    });
    const skill = makeSkill({ usedByAgents: [makeAgent()] });
    await renderNode(
      <AgentsUsingSkillDialog open onOpenChange={() => {}} companyId="company-1" skill={skill} />,
    );
    const select = document.body.querySelector<HTMLSelectElement>("select");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "ver-2");
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(mockAgentsApi.syncSkills).toHaveBeenCalledTimes(1);
    const [, sentEntries] = mockAgentsApi.syncSkills.mock.calls[0];
    expect(sentEntries).toContainEqual({ key: "paperclip/other", versionId: null });
    expect(sentEntries).toContainEqual({ key: "paperclip/demo", versionId: "ver-2" });
  });

  it("hides mutating controls in read-only mode but keeps the roster", async () => {
    const skill = makeSkill({ usedByAgents: [makeAgent()] });
    await renderNode(
      <AgentsUsingSkillDialog
        open
        onOpenChange={() => {}}
        companyId="company-1"
        skill={skill}
        canManage={false}
      />,
    );
    expect(document.body.textContent).toContain("Reviewer");
    expect(document.body.querySelector('button[aria-label^="Remove this skill from"]')).toBeNull();
    expect(document.body.querySelector("select")).toBeNull();
  });
});
