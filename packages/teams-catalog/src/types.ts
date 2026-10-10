export type CatalogTeamKind = "bundled" | "optional";

export type CatalogTeamTrustLevel =
  | "markdown_only"
  | "assets"
  | "scripts_executables"
  | "external_sources";

export type CatalogTeamCompatibility = "compatible" | "unknown" | "invalid";

export type CatalogTeamFileKind =
  | "team"
  | "agent"
  | "project"
  | "task"
  | "skill"
  | "extension"
  | "readme"
  | "reference"
  | "script"
  | "asset"
  | "markdown"
  | "other";

export type CatalogTeamSkillRequirementType =
  | "catalog"
  | "local"
  | "skills_sh"
  | "github"
  | "url"
  | "local_path"
  | "agent_package";

export interface CatalogTeamSkillRequirement {
  type: CatalogTeamSkillRequirementType;
  ref: string;
  agentSlugs: string[];
  resolved: boolean;
  catalogSkillId?: string;
  catalogSkillKey?: string;
  localPath?: string;
  sourceLocator?: string;
  sourceRef?: string;
}

export interface CatalogTeamEnvInputSummary {
  key: string;
  agentSlug: string | null;
  projectSlug: string | null;
  kind: "secret" | "plain";
  requirement: "required" | "optional";
}

export interface CatalogTeamSourceRef {
  type: Exclude<CatalogTeamSkillRequirementType, "catalog" | "local"> | "include";
  ref: string;
  pinned: boolean;
}

export interface CatalogTeamFile {
  path: string;
  kind: CatalogTeamFileKind;
  sizeBytes: number;
  sha256: string;
}

export interface CatalogTeam {
  id: string;
  key: string;
  kind: CatalogTeamKind;
  category: string;
  slug: string;
  name: string;
  description: string;
  path: string;
  entrypoint: "TEAM.md";
  schema: "agentcompanies/v1";
  defaultInstall: boolean;
  recommendedForCompanyTypes: string[];
  tags: string[];
  counts: {
    agents: number;
    projects: number;
    tasks: number;
    routines: number;
    localSkills: number;
    catalogSkills: number;
    externalSkillSources: number;
  };
  rootAgentSlugs: string[];
  agentSlugs: string[];
  projectSlugs: string[];
  requiredSkills: CatalogTeamSkillRequirement[];
  envInputs: CatalogTeamEnvInputSummary[];
  sourceRefs: CatalogTeamSourceRef[];
  files: CatalogTeamFile[];
  trustLevel: CatalogTeamTrustLevel;
  compatibility: CatalogTeamCompatibility;
  contentHash: string;
}

export interface CatalogManifest {
  schemaVersion: 1;
  packageName: "@paperclipai/teams-catalog";
  packageVersion: string;
  generatedAt: string;
  teams: CatalogTeam[];
}

export interface CatalogValidationResult {
  valid: boolean;
  errors: string[];
  manifest: CatalogManifest;
}
