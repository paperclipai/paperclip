import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillVersion,
} from "@paperclipai/shared";
import { SkillDetailPage } from "@/pages/CompanySkills";

type DetailTab = "overview" | "files" | "versions" | "agents";

const NOW = new Date("2026-06-01T12:00:00Z");

const MOCK_DETAIL: CompanySkillDetail = {
  id: "skill-1",
  companyId: "company-1",
  key: "paperclipai/paperclip/deep-research",
  slug: "deep-research",
  name: "deep-research",
  description:
    "Fan-out web searches, fetch sources, adversarially verify claims, and synthesize a cited report. Best for multi-source, fact-checked research where one search angle will not find everything.",
  markdown: "# deep-research\n\nResearch harness.",
  sourceType: "github",
  sourceLocator: "github.com/paperclipai/skills",
  sourceRef: "a1b2c3d4e5f6",
  trustLevel: "scripts_executables",
  compatibility: "compatible",
  fileInventory: [
    { path: "SKILL.md", kind: "skill" },
    { path: "references/methodology.md", kind: "reference" },
    { path: "scripts/fetch.ts", kind: "script" },
  ],
  iconUrl: null,
  color: "#6366f1",
  tagline: "Multi-source research with citation-grade synthesis.",
  authorName: "Astra",
  homepageUrl: null,
  categories: ["research", "writing"],
  sharingScope: "company",
  publicShareToken: null,
  forkedFromSkillId: null,
  forkedFromCompanyId: null,
  starCount: 211,
  installCount: 96,
  forkCount: 17,
  currentVersionId: "v-2",
  metadata: null,
  createdAt: NOW,
  updatedAt: NOW,
  attachedAgentCount: 4,
  existingForks: [],
  usedByAgents: [
    { id: "a-1", name: "Astra", urlKey: "astra", adapterType: "process", desired: true, actualState: null, versionId: null },
    { id: "a-2", name: "Scout", urlKey: "scout", adapterType: "http", desired: true, actualState: null, versionId: null },
    { id: "a-3", name: "Quill", urlKey: "quill", adapterType: "process", desired: true, actualState: null, versionId: null },
    { id: "a-4", name: "Marlow", urlKey: "marlow", adapterType: "process", desired: true, actualState: null, versionId: null },
  ],
  editable: true,
  editableReason: null,
  sourceLabel: "GitHub",
  sourceBadge: "github",
  sourcePath: "github.com/paperclipai/skills/tree/main/deep-research",
  currentVersion: {
    id: "v-2",
    companyId: "company-1",
    companySkillId: "skill-1",
    revisionNumber: 2,
    label: "tighten verifier",
    fileInventory: [],
    authorAgentId: "a-1",
    authorUserId: null,
    createdAt: NOW,
  },
  starredByCurrentActor: true,
};

const MOCK_VERSIONS: CompanySkillVersion[] = [
  {
    id: "v-2",
    companyId: "company-1",
    companySkillId: "skill-1",
    revisionNumber: 2,
    label: "tighten verifier",
    fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# v2" }],
    authorAgentId: "a-1",
    authorUserId: null,
    createdAt: NOW,
  },
  {
    id: "v-1",
    companyId: "company-1",
    companySkillId: "skill-1",
    revisionNumber: 1,
    label: null,
    fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# v1" }],
    authorAgentId: "a-1",
    authorUserId: null,
    createdAt: NOW,
  },
];

const MOCK_FILE: CompanySkillFileDetail = {
  skillId: "skill-1",
  path: "SKILL.md",
  kind: "skill",
  content: "---\nname: deep-research\n---\n\n# deep-research\n\nFan out, verify, synthesize.",
  language: "markdown",
  markdown: true,
  editable: true,
};

// Agents available to attach, including a paused one to exercise the badge.
const MOCK_ATTACH_AGENTS = [
  { id: "a-1", name: "Astra", adapterType: "process", supportsSkills: true, required: false, icon: "telescope", paused: false },
  { id: "a-2", name: "Scout", adapterType: "http", supportsSkills: true, required: false, icon: "compass", paused: false },
  { id: "a-3", name: "Quill", adapterType: "process", supportsSkills: true, required: false, icon: "feather", paused: true },
  { id: "a-4", name: "Marlow", adapterType: "process", supportsSkills: true, required: false, icon: "bot", paused: false },
  { id: "a-5", name: "Pixel", adapterType: "process", supportsSkills: true, required: false, icon: "palette", paused: false },
  { id: "a-6", name: "Forge", adapterType: "process", supportsSkills: false, required: false, icon: "hammer", paused: false },
];

function SkillDetailHarness({ initialTab = "overview" as DetailTab }: { initialTab?: DetailTab }) {
  const [activeTab, setActiveTab] = useState<DetailTab>(initialTab);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState(MOCK_FILE.content);

  return (
    <SkillDetailPage
      detail={MOCK_DETAIL}
      catalogSource={{
        type: "github",
        hostname: "github.com",
        owner: "mvanhorn",
        repo: "last30days-skill",
        ref: "v3.3.0",
        commit: "daca71f89eb71d0d56d01a43ed7627aa919dba4f",
        path: "skills/last30days",
        url: "https://github.com/mvanhorn/last30days-skill/tree/v3.3.0/skills/last30days",
      }}
      loading={false}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      selectedPath="SKILL.md"
      file={MOCK_FILE}
      fileLoading={false}
      viewMode={viewMode}
      editMode={editMode}
      draft={draft}
      setViewMode={setViewMode}
      setEditMode={setEditMode}
      setDraft={setDraft}
      onSave={() => {}}
      savePending={false}
      versions={MOCK_VERSIONS}
      versionsLoading={false}
      attachAgents={MOCK_ATTACH_AGENTS}
      onSubmitAttach={() => {}}
      attachPending={false}
      expandedDirs={new Set<string>()}
      onToggleDir={() => {}}
      onSelectPath={() => {}}
      updateStatus={{
        supported: true,
        reason: null,
        trackingRef: "main",
        currentRef: "a1b2c3d4e5f6",
        latestRef: "a1b2c3d4e5f6",
        hasUpdate: false,
        installedHash: null,
        originHash: null,
        userModifiedAt: null,
        updateHoldReason: null,
        auditVerdict: null,
        auditCodes: [],
      }}
      updateStatusLoading={false}
      onCheckUpdates={() => {}}
      checkUpdatesPending={false}
      onInstallUpdate={() => {}}
      installUpdatePending={false}
      onToggleStar={() => {}}
      starPending={false}
      onFork={() => {}}
      onUpdateSettings={() => {}}
      updateSettingsPending={false}
      onDelete={() => {}}
      deletePending={false}
    />
  );
}

const meta: Meta<typeof SkillDetailHarness> = {
  title: "Skills Store/Skill detail",
  component: SkillDetailHarness,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof SkillDetailHarness>;

export const Overview: Story = { args: { initialTab: "overview" } };
export const AgentsTab: Story = { args: { initialTab: "agents" } };
export const FilesTab: Story = { args: { initialTab: "files" } };
export const VersionsTab: Story = { args: { initialTab: "versions" } };
