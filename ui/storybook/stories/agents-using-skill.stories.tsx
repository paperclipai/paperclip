import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  CompanySkillDetail,
  CompanySkillUsageAgent,
  CompanySkillVersion,
} from "@paperclipai/shared";
import {
  AgentsUsingSkillBadge,
  AgentsUsingSkillDialog,
} from "@/components/skill-studio/AgentsUsingSkillDialog";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "company-storybook";
const SKILL_ID = "skill-code-review";

function makeVersion(overrides: Partial<CompanySkillVersion>): CompanySkillVersion {
  return {
    id: "ver",
    companyId: COMPANY_ID,
    companySkillId: SKILL_ID,
    revisionNumber: 1,
    label: null,
    fileInventory: [],
    authorAgentId: null,
    authorUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const VERSIONS: CompanySkillVersion[] = [
  makeVersion({ id: "ver-3", revisionNumber: 3, label: "polish pass" }),
  makeVersion({ id: "ver-2", revisionNumber: 2 }),
  makeVersion({ id: "ver-1", revisionNumber: 1 }),
];

const AGENTS = [
  { id: "agent-1", name: "Reviewer", urlKey: "reviewer", adapterType: "claude_local", icon: "bot", status: "idle" },
  { id: "agent-2", name: "Coder", urlKey: "coder", adapterType: "codex_local", icon: "code", status: "idle" },
  { id: "agent-3", name: "Planner", urlKey: "planner", adapterType: "claude_local", icon: "compass", status: "idle" },
  { id: "agent-4", name: "QA Bot", urlKey: "qa-bot", adapterType: "claude_local", icon: "bug", status: "idle" },
];

function usageAgent(overrides: Partial<CompanySkillUsageAgent>): CompanySkillUsageAgent {
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

function makeSkill(overrides: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: SKILL_ID,
    companyId: COMPANY_ID,
    key: "paperclip/code-review",
    slug: "code-review",
    name: "Code Review",
    description: "Structured pull-request review with actionable findings.",
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
    attachedAgentCount: 3,
    usedByAgents: [
      usageAgent({ id: "agent-1", name: "Reviewer", urlKey: "reviewer", versionId: null }),
      usageAgent({ id: "agent-2", name: "Coder", urlKey: "coder", adapterType: "codex_local", versionId: "ver-1" }),
      usageAgent({ id: "agent-3", name: "Planner", urlKey: "planner", versionId: "ver-3" }),
    ],
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: null,
    currentVersion: makeVersion({ id: "ver-3", revisionNumber: 3, label: "polish pass" }),
    starredByCurrentActor: false,
    existingForks: [],
    ...overrides,
  };
}

// Prime the react-query cache so the lazy versions/agents lookups resolve
// offline (storybook staleTime is Infinity, so nothing refetches).
function Seed({ skill, children }: { skill: CompanySkillDetail; children: ReactNode }) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.companySkills.versions(COMPANY_ID, skill.id), VERSIONS);
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), AGENTS);
  return <>{children}</>;
}

const meta: Meta = {
  title: "Skill Studio/AgentsUsingSkill",
  parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj;

/** The header badge as it sits next to the other Studio badges. */
export const HeaderBadge: Story = {
  render: () => {
    const skill = makeSkill();
    return (
      <Seed skill={skill}>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-base font-semibold">Code Review</span>
          <span className="font-mono text-xs text-muted-foreground">v3</span>
          <AgentsUsingSkillBadge companyId={COMPANY_ID} skill={skill} />
        </div>
      </Seed>
    );
  },
};

export const HeaderBadgeEmpty: Story = {
  render: () => {
    const skill = makeSkill({ usedByAgents: [], attachedAgentCount: 0 });
    return (
      <Seed skill={skill}>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-base font-semibold">Code Review</span>
          <span className="font-mono text-xs text-muted-foreground">v3</span>
          <AgentsUsingSkillBadge companyId={COMPANY_ID} skill={skill} />
        </div>
      </Seed>
    );
  },
};

function OpenDialog({ skill, canManage = true }: { skill: CompanySkillDetail; canManage?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Seed skill={skill}>
      <AgentsUsingSkillDialog
        open={open}
        onOpenChange={setOpen}
        companyId={COMPANY_ID}
        skill={skill}
        canManage={canManage}
      />
    </Seed>
  );
}

/** The management modal with three agents, mixed latest/pinned versions. */
export const ManagementModal: Story = {
  render: () => <OpenDialog skill={makeSkill()} />,
};

/** Read-only roster: names link out, no mutating controls. */
export const ReadOnlyRoster: Story = {
  render: () => <OpenDialog skill={makeSkill()} canManage={false} />,
};

/** Zero-agent empty state with the add-agent picker as the primary action. */
export const EmptyState: Story = {
  render: () => <OpenDialog skill={makeSkill({ usedByAgents: [], attachedAgentCount: 0 })} />,
};
