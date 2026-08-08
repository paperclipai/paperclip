import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, GitFork } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  CompanySkillDetail,
  CompanySkillForkPrecheckResult,
  CompanySkillForkSummary,
  CompanySkillUsageAgent,
} from "@paperclipai/shared";
import { ForkSkillDialog } from "@/components/skill-studio/ForkSkillDialog";
import {
  ProjectScanNotice,
  SkillLineageChip,
} from "@/components/skill-studio/SkillProvenance";
import { AgentsUsingSkillBadge } from "@/components/skill-studio/AgentsUsingSkillDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "company-storybook";
const SKILL_ID = "skill-deep-research";
const ORIGINAL_ID = "skill-deep-research"; // external original
const FORK_ID = "skill-deep-research-copy"; // the editable fork

function usageAgent(over: Partial<CompanySkillUsageAgent>): CompanySkillUsageAgent {
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

const USAGE_AGENTS: CompanySkillUsageAgent[] = [
  usageAgent({ id: "agent-1", name: "Reviewer", urlKey: "reviewer" }),
  usageAgent({ id: "agent-2", name: "Coder", urlKey: "coder", adapterType: "codex_local" }),
  usageAgent({ id: "agent-3", name: "Planner", urlKey: "planner" }),
];

function makeSkill(over: Partial<CompanySkillDetail> = {}): CompanySkillDetail {
  return {
    id: SKILL_ID,
    companyId: COMPANY_ID,
    key: "github/anthropics/skills",
    slug: "deep-research",
    name: "Deep Research",
    description: "Multi-source research with adversarial verification.",
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
    currentVersionId: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    attachedAgentCount: USAGE_AGENTS.length,
    usedByAgents: USAGE_AGENTS,
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

function makePrecheck(
  over: Partial<CompanySkillForkPrecheckResult> = {},
): CompanySkillForkPrecheckResult {
  return {
    skillId: SKILL_ID,
    original: {
      id: ORIGINAL_ID,
      name: "Deep Research",
      slug: "deep-research",
      sourceType: "github",
      sourceLocator: "https://github.com/anthropics/skills",
      sourceRef: "0123456789abcdef0123456789abcdef01234567",
    },
    agentUsageCount: USAGE_AGENTS.length,
    usedByAgents: USAGE_AGENTS,
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
    forkedFromSkillId: ORIGINAL_ID,
    forkedFromCompanyId: COMPANY_ID,
    currentVersionId: "v1",
    createdByCurrentActor: true,
    diverged: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  };
}

/** Prime react-query so the dialog's precheck + lineage lookups resolve offline. */
function Seed({
  skill,
  precheck,
  children,
}: {
  skill: CompanySkillDetail;
  precheck?: CompanySkillForkPrecheckResult;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(
    queryKeys.companySkills.forkPrecheck(COMPANY_ID, skill.id),
    precheck ?? makePrecheck(),
  );
  // Original detail for the lineage chip on forked skills.
  queryClient.setQueryData(
    queryKeys.companySkills.detail(COMPANY_ID, ORIGINAL_ID),
    makeSkill(),
  );
  return <>{children}</>;
}

const meta: Meta = {
  title: "Skill Studio/EditACopy",
  parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj;

/** The read-only external-skill banner with the primary "Edit a copy" CTA. */
export const ReadOnlyBannerCTA: Story = {
  render: () => (
    <div className="w-[30rem] max-w-full overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-start gap-3 border-b border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p>
            This skill comes from GitHub and is read-only. Make an editable copy
            to change it — the original stays untouched.
          </p>
          <Button type="button" size="sm" className="mt-2">
            <GitFork className="mr-1.5 h-3.5 w-3.5" />
            Edit a copy
          </Button>
        </div>
      </div>
      <div className="px-3 py-1.5 font-mono text-xs text-muted-foreground">SKILL.md</div>
    </div>
  ),
};

/** Confirm dialog: three agents use the skill, switch toggle default ON (§3.2). */
export const ForkDialogAgentsSwitchOn: Story = {
  render: () => {
    const skill = makeSkill();
    return (
      <Seed skill={skill}>
        <ForkSkillDialog companyId={COMPANY_ID} skill={skill} open onOpenChange={() => {}} />
      </Seed>
    );
  },
};

/** Same dialog with no agents assigned — toggle hidden, zero-usage disclosure. */
export const ForkDialogNoAgents: Story = {
  render: () => {
    const skill = makeSkill({ usedByAgents: [], attachedAgentCount: 0 });
    return (
      <Seed skill={skill} precheck={makePrecheck({ agentUsageCount: 0, usedByAgents: [] })}>
        <ForkSkillDialog companyId={COMPANY_ID} skill={skill} open onOpenChange={() => {}} />
      </Seed>
    );
  },
};

/** Fork-sprawl guard: an un-diverged copy already exists (§5). */
export const ForkDialogExistingCopy: Story = {
  render: () => {
    const existing = [makeForkSummary()];
    const skill = makeSkill({ existingForks: existing });
    return (
      <Seed skill={skill} precheck={makePrecheck({ existingForks: existing })}>
        <ForkSkillDialog companyId={COMPANY_ID} skill={skill} open onOpenChange={() => {}} />
      </Seed>
    );
  },
};

/** Studio header row of a forked skill, showing the lineage chip. */
export const ForkedSkillHeader: Story = {
  render: () => {
    const fork = makeSkill({
      id: FORK_ID,
      name: "Deep Research (copy)",
      slug: "deep-research-fork",
      sourceType: "local_path",
      sourceLocator: null,
      sourceRef: null,
      editable: true,
      editableReason: null,
      forkedFromSkillId: ORIGINAL_ID,
      usedByAgents: [],
      attachedAgentCount: 0,
    });
    return (
      <Seed skill={fork}>
        <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-base font-semibold">Deep Research (copy)</span>
          <Badge variant="secondary">Unsaved edits</Badge>
          <SkillLineageChip companyId={COMPANY_ID} forkedFromSkillId={ORIGINAL_ID} />
          <AgentsUsingSkillBadge companyId={COMPANY_ID} skill={fork} />
        </div>
      </Seed>
    );
  },
};

/** Repo-synced (project_scan) source notice with the "Edit a copy instead" path (§3.3). */
export const ProjectScanSourceNotice: Story = {
  render: () => {
    const skill = makeSkill({
      name: "Repo Linter",
      sourceType: "local_path",
      sourceBadge: "local",
      metadata: { sourceKind: "project_scan" },
      sourcePath: "acme-app/.claude/skills/repo-linter",
      sourceLabel: "acme-app",
      editable: true,
      editableReason: null,
    });
    return (
      <div className="w-[30rem] max-w-full overflow-hidden rounded-md border border-border bg-card">
        <ProjectScanNotice skill={skill} onEditACopy={() => {}} />
      </div>
    );
  },
};
