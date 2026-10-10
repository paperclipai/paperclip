import type {
  CatalogTeam,
  CatalogTeamSkillPreparation,
  InstalledCatalogTeam,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Shared Team Catalog fixtures.
//
// Used by both the Storybook stories (ui/storybook/stories/team-catalog.stories.tsx)
// and the in-app /design-guide showcase so the two surfaces stay in sync.
// ---------------------------------------------------------------------------

export const sampleTeam: CatalogTeam = {
  id: "paperclipai:bundled:company-defaults:core-exec-team",
  key: "paperclipai/bundled/company-defaults/core-exec-team",
  kind: "bundled",
  category: "company-defaults",
  slug: "core-exec-team",
  name: "Core Exec Team",
  description:
    "A starter executive team: a CEO who manages a CTO and a CMO, plus a launch project and a weekly standup routine. Installs ready-to-run agents you can customize.",
  path: "catalog/bundled/company-defaults/core-exec-team",
  entrypoint: "TEAM.md",
  schema: "agentcompanies/v1",
  defaultInstall: true,
  recommendedForCompanyTypes: ["company-root"],
  tags: ["exec", "starter"],
  counts: {
    agents: 3,
    projects: 1,
    tasks: 1,
    routines: 1,
    localSkills: 1,
    catalogSkills: 1,
    externalSkillSources: 1,
  },
  rootAgentSlugs: ["ceo"],
  agentSlugs: ["ceo", "cto", "cmo"],
  projectSlugs: ["launch"],
  requiredSkills: [
    { type: "catalog", ref: "engineering/code-review", agentSlugs: ["cto"], resolved: true, catalogSkillKey: "engineering/code-review" },
    { type: "github", ref: "acme/growth-playbook@v1.2.0", agentSlugs: ["cmo"], resolved: false, sourceRef: "v1.2.0" },
  ],
  envInputs: [
    { key: "OPENAI_API_KEY", agentSlug: "cto", projectSlug: null, kind: "secret", requirement: "required" },
    { key: "DEFAULT_TIMEZONE", agentSlug: null, projectSlug: "launch", kind: "plain", requirement: "optional" },
  ],
  sourceRefs: [
    { type: "github", ref: "acme/growth-playbook@v1.2.0", pinned: true },
    { type: "url", ref: "https://example.com/policies/brand.md", pinned: false },
  ],
  files: [
    { path: "TEAM.md", kind: "team", sizeBytes: 2144, sha256: "a1" },
    { path: "README.md", kind: "readme", sizeBytes: 980, sha256: "a2" },
    { path: "agents/ceo/AGENTS.md", kind: "agent", sizeBytes: 1200, sha256: "a3" },
    { path: "agents/cto/AGENTS.md", kind: "agent", sizeBytes: 1100, sha256: "a4" },
    { path: "agents/cmo/AGENTS.md", kind: "agent", sizeBytes: 1050, sha256: "a5" },
    { path: "projects/launch/PROJECT.md", kind: "project", sizeBytes: 640, sha256: "a6" },
  ],
  trustLevel: "external_sources",
  compatibility: "compatible",
  contentHash: "sha256:deadbeefdeadbeefdeadbeefdeadbeef",
  packageName: "@paperclipai/teams-catalog",
  packageVersion: "0.1.0",
};

export const optionalTeam: CatalogTeam = {
  ...sampleTeam,
  id: "paperclipai:optional:software-development:platform-pod",
  key: "paperclipai/optional/software-development/platform-pod",
  kind: "optional",
  category: "software-development",
  slug: "platform-pod",
  name: "Platform Engineering Pod",
  description: "An optional platform pod with a tech lead and two engineers.",
  recommendedForCompanyTypes: [],
  counts: { ...sampleTeam.counts, agents: 4, routines: 2 },
  rootAgentSlugs: ["tech-lead"],
  agentSlugs: ["tech-lead", "eng-1", "eng-2", "sre"],
  trustLevel: "markdown_only",
  sourceRefs: [],
};

export const warnTeam: CatalogTeam = {
  ...sampleTeam,
  id: "paperclipai:optional:research:lab-with-local-source",
  slug: "lab-with-local-source",
  name: "Research Lab (local source)",
  kind: "optional",
  category: "research",
  trustLevel: "scripts_executables",
  sourceRefs: [
    { type: "url", ref: "https://example.com/unpinned.md", pinned: false },
    { type: "local_path", ref: "/Users/dev/skills/secret-sauce", pinned: false },
  ],
};

// Server-computed installed-team state (PAP-10256). Drives the `INSTALLED · N`
// group, the per-row out-of-date badge, and the detail header chip. Shared by
// the Storybook stories and /design-guide showcase so they stay in sync.
export const outOfDateInstalledState: InstalledCatalogTeam = {
  catalogId: sampleTeam.id,
  catalogKey: sampleTeam.key,
  present: true,
  currentContentHash: sampleTeam.contentHash,
  installedOriginHashes: ["sha256:0000older0000older0000older"],
  agentCount: 3,
  outOfDate: true,
};

export const currentInstalledState: InstalledCatalogTeam = {
  ...outOfDateInstalledState,
  installedOriginHashes: [sampleTeam.contentHash],
  outOfDate: false,
};

export const sampleSkillPreparations: CatalogTeamSkillPreparation[] = [
  { type: "catalog", ref: "engineering/code-review", agentSlugs: ["cto"], action: "already_in_package", catalogSkillId: "skill-1", catalogSkillKey: "engineering/code-review", sourceLocator: null, sourceRef: null, reason: null },
  { type: "github", ref: "acme/growth-playbook@v1.2.0", agentSlugs: ["cmo"], action: "external_import_required", catalogSkillId: null, catalogSkillKey: null, sourceLocator: "github.com/acme/growth-playbook", sourceRef: "v1.2.0", reason: "Resolved from GitHub at install time" },
];

// Onboarding "Pick a starter team" grid (design §6): `defaultInstall` bundled
// teams restricted to markdown_only/assets trust. Shared by the TeamCard
// Storybook fixture and the /design-guide showcase so they stay in sync.
export const onboardingTeams: CatalogTeam[] = [
  {
    ...sampleTeam,
    trustLevel: "markdown_only",
    sourceRefs: [],
    requiredSkills: [],
    counts: { ...sampleTeam.counts, localSkills: 0, catalogSkills: 0, externalSkillSources: 0 },
  },
  {
    ...sampleTeam,
    id: "paperclipai:bundled:company-defaults:growth-pod",
    key: "paperclipai/bundled/company-defaults/growth-pod",
    slug: "growth-pod",
    name: "Growth Pod",
    description:
      "A lean growth squad: a head of growth managing a content marketer and a data analyst, wired to a launch project and a weekly metrics routine.",
    tags: ["growth", "marketing", "starter"],
    counts: { agents: 3, projects: 1, tasks: 0, routines: 1, localSkills: 0, catalogSkills: 0, externalSkillSources: 0 },
    rootAgentSlugs: ["head-of-growth"],
    agentSlugs: ["head-of-growth", "content-marketer", "data-analyst"],
    trustLevel: "assets",
    sourceRefs: [],
    requiredSkills: [],
  },
  {
    ...sampleTeam,
    id: "paperclipai:bundled:company-defaults:support-pod",
    key: "paperclipai/bundled/company-defaults/support-pod",
    slug: "support-pod",
    name: "Support Pod",
    description: "A two-person support desk with a lead and an agent, plus a triage routine.",
    tags: ["support", "ops"],
    counts: { agents: 2, projects: 0, tasks: 0, routines: 1, localSkills: 0, catalogSkills: 0, externalSkillSources: 0 },
    rootAgentSlugs: ["support-lead"],
    agentSlugs: ["support-lead", "support-agent"],
    projectSlugs: [],
    trustLevel: "markdown_only",
    sourceRefs: [],
    requiredSkills: [],
  },
];
