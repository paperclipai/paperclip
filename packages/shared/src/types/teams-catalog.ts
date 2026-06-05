import type {
  CompanyPortabilityAdapterOverride,
  CompanyPortabilityAgentSelection,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreviewResult,
} from "./company-portability.js";

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
  packageName?: string;
  packageVersion?: string;
}

export interface CatalogManifest {
  schemaVersion: 1;
  packageName: "@paperclipai/teams-catalog";
  packageVersion: string;
  generatedAt: string;
  teams: CatalogTeam[];
}

export interface CatalogTeamListQuery {
  kind?: CatalogTeamKind;
  category?: string;
  q?: string;
}

export interface CatalogTeamFileDetail {
  catalogTeamId: string;
  path: string;
  kind: CatalogTeamFileKind;
  content: string;
  language: string | null;
  markdown: boolean;
}

export interface CatalogTeamSourcePolicy {
  allowExternalSources?: boolean;
  allowUnpinnedOptionalSources?: boolean;
  allowLocalPathSources?: boolean;
}

export interface CatalogTeamImportOptions {
  targetManagerAgentId?: string | null;
  targetManagerSlug?: string | null;
  include?: Partial<CompanyPortabilityInclude>;
  agents?: CompanyPortabilityAgentSelection;
  collisionStrategy?: CompanyPortabilityCollisionStrategy;
  nameOverrides?: Record<string, string>;
  selectedFiles?: string[];
  sourcePolicy?: CatalogTeamSourcePolicy;
}

export interface CatalogTeamInstallOptions extends CatalogTeamImportOptions {
  adapterOverrides?: Record<string, CompanyPortabilityAdapterOverride>;
  secretValues?: Record<string, string>;
}

export type CatalogTeamSkillPreparationAction =
  | "already_in_package"
  | "catalog_install_required"
  | "external_import_required"
  | "blocked";

export interface CatalogTeamSkillPreparation {
  type: CatalogTeamSkillRequirementType;
  ref: string;
  agentSlugs: string[];
  action: CatalogTeamSkillPreparationAction;
  catalogSkillId: string | null;
  catalogSkillKey: string | null;
  sourceLocator: string | null;
  sourceRef: string | null;
  reason: string | null;
}

export interface CatalogTeamImportPreviewResult {
  team: CatalogTeam;
  portabilityPreview: CompanyPortabilityPreviewResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
  errors: string[];
}

export interface CatalogTeamInstallResult {
  team: CatalogTeam;
  portabilityImport: CompanyPortabilityImportResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
}

/**
 * Server-computed installed-team state for a company. Surfaced by
 * `GET /api/companies/:companyId/teams/catalog/installed` and consumed by the
 * Team Catalog UI to render the `INSTALLED · N` group, per-row out-of-date
 * badges, and the detail header "Update available" chip (design
 * [PAP-10238 §3.2 + §5]).
 *
 * `outOfDate` is true when at least one installed agent carries a
 * `metadata.paperclip.catalogTeam.originHash` that differs from the catalog
 * team's current `contentHash`. `present` is false when the installed team no
 * longer resolves to a catalog entry (e.g. removed from the package) — in that
 * case the comparison is unknown and `outOfDate` stays false.
 */
export interface InstalledCatalogTeam {
  catalogId: string;
  catalogKey: string | null;
  /** True when the installed catalogId still resolves to a current catalog team. */
  present: boolean;
  /** Current catalog `contentHash` for this team, or null when not present. */
  currentContentHash: string | null;
  /** Distinct `originHash` values recorded across installed agents. */
  installedOriginHashes: string[];
  /** Number of non-terminated agents carrying this team's provenance. */
  agentCount: number;
  /** True when a present team has at least one stale installed originHash. */
  outOfDate: boolean;
}
