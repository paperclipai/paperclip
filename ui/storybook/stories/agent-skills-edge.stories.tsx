import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { Agent, AgentSkillSnapshot, CompanySkillListItem } from "@paperclipai/shared";
import { AgentSkillsTab } from "@/pages/agent-skills/AgentSkillsTab";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/queryKeys";

// QA-only fixtures (PAP-13195) to exercise AC5 (stale desired-skill warning) and
// AC6 (collapsed read-only "Detected on adapter" section) - states the shipped
// acpx_local stories do not cover.

const COMPANY_ID = "company-qa-edge";

const defaultStoreSkillFields = {
  iconUrl: null,
  color: null,
  tagline: null,
  authorName: null,
  homepageUrl: null,
  categories: [] as string[],
  sharingScope: "company" as const,
  publicShareToken: null,
  forkedFromSkillId: null,
  forkedFromCompanyId: null,
  starCount: 0,
  installCount: 1,
  forkCount: 0,
  currentVersionId: null,
};

function libSkill(key: string, name: string, description: string): CompanySkillListItem {
  return {
    id: `skill-${key}`,
    companyId: COMPANY_ID,
    key,
    slug: key,
    name,
    description,
    sourceType: "local_path",
    sourceLocator: `skills/${key}`,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    ...defaultStoreSkillFields,
    createdAt: new Date("2026-04-12T09:00:00.000Z"),
    updatedAt: new Date("2026-04-22T15:30:00.000Z"),
    attachedAgentCount: 1,
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: `skills/${key}`,
    catalogKind: null,
    originHash: null,
    packageName: null,
    packageVersion: null,
  } as CompanySkillListItem;
}

const library: CompanySkillListItem[] = [
  libSkill("paperclip", "Paperclip", "Coordination skill: heartbeats, checkout, comments, and routine API patterns."),
  libSkill("design-guide", "Design guide", "Paperclip UI design system reference: tokens, typography, status colors."),
];

function buildAgent(agentId: string, desiredSkills: string[]): Agent {
  return {
    id: agentId,
    companyId: COMPANY_ID,
    name: "ACPX Claude",
    urlKey: "acpx-claude-edge",
    role: "engineer",
    title: "ACPX Claude agent",
    icon: "code",
    status: "idle",
    reportsTo: null,
    capabilities: "Routes work through the ACPX adapter.",
    adapterType: "acpx_local",
    adapterConfig: {
      agent: "claude",
      mode: "persistent",
      permissionMode: "approve-all",
      paperclipSkillSync: { desiredSkills },
    },
    runtimeConfig: {},
    budgetMonthlyCents: 100_000,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-30T12:00:00.000Z"),
    updatedAt: new Date("2026-04-30T12:00:00.000Z"),
  } as Agent;
}

// AC5: a desired key that is no longer in the company library -> stale warning row.
function staleSnapshot(): AgentSkillSnapshot {
  return {
    adapterType: "acpx_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills: ["paperclip", "legacy-retired-skill"],
    warnings: [],
    entries: [
      {
        key: "paperclip",
        runtimeName: "paperclip",
        desired: true,
        managed: true,
        state: "configured",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/paperclip",
        targetPath: null,
        detail: "Will be mounted into the next ACPX Claude session.",
      },
    ],
  };
}

// AC6: a user-installed skill detected on the adapter that is NOT in the company
// library -> read-only lock row inside the collapsed "Detected on adapter" section.
function detectedSnapshot(): AgentSkillSnapshot {
  return {
    adapterType: "acpx_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills: ["paperclip"],
    warnings: [],
    entries: [
      {
        key: "paperclip",
        runtimeName: "paperclip",
        desired: true,
        managed: true,
        state: "configured",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/paperclip",
        targetPath: null,
        detail: "Will be mounted into the next ACPX Claude session.",
      },
      {
        key: "my-local-hack",
        runtimeName: "my-local-hack",
        desired: false,
        managed: false,
        state: "external",
        origin: "user_installed",
        originLabel: "Installed by user",
        locationLabel: "~/.claude/skills/my-local-hack",
        readOnly: true,
        sourcePath: null,
        targetPath: null,
        detail: "Detected in the adapter's skills directory; managed outside Paperclip.",
      },
    ] as AgentSkillSnapshot["entries"],
  };
}

function StoryFrame({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header className="space-y-2">
        <Badge variant="outline" className="rounded-full px-3 py-1 text-xs uppercase tracking-wide">
          QA edge state
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </header>
      <Card className="shadow-none border-border">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Agent detail - Skills tab</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

function EdgeState({ agent, snapshot }: { agent: Agent; snapshot: AgentSkillSnapshot }) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.companySkills.list(COMPANY_ID), library);
  queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
  return <AgentSkillsTab agent={agent} companyId={COMPANY_ID} />;
}

const meta: Meta = {
  title: "QA / Agent skills edge states",
  parameters: { layout: "fullscreen" },
};
export default meta;

export const StaleWarning: StoryObj = {
  name: "Stale desired-skill warning (AC5)",
  render: () => (
    <StoryFrame
      title="Stale desired-skill warning"
      subtitle="An enabled skill key that no longer exists in the company library renders as a compact, removable warning row."
    >
      <EdgeState agent={buildAgent("agent-stale", ["paperclip", "legacy-retired-skill"])} snapshot={staleSnapshot()} />
    </StoryFrame>
  ),
};

export const DetectedAdapter: StoryObj = {
  name: "Detected on adapter - read-only (AC6)",
  render: () => (
    <StoryFrame
      title="Detected on adapter (read-only)"
      subtitle="A user-installed skill outside Paperclip's management shows in a collapsed, read-only section with a lock icon."
    >
      <EdgeState agent={buildAgent("agent-detected", ["paperclip"])} snapshot={detectedSnapshot()} />
    </StoryFrame>
  ),
};
