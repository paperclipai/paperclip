export type CatalogSkillKind = "bundled" | "optional";

export type CatalogTrustLevel = "markdown_only" | "assets" | "scripts_executables";

export type CatalogCompatibility = "compatible" | "unknown" | "invalid";

export type CatalogSkillFileKind = "skill" | "markdown" | "reference" | "script" | "asset" | "other";

export interface CatalogSkillFile {
  path: string;
  kind: CatalogSkillFileKind;
  sizeBytes: number;
  sha256: string;
}

export interface CatalogSkillGitHubSource {
  type: "github";
  hostname: string;
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  path: string;
  url: string;
}

export type CatalogSkillSource = CatalogSkillGitHubSource;

export interface CatalogSkill {
  id: string;
  key: string;
  kind: CatalogSkillKind;
  category: string;
  slug: string;
  name: string;
  description: string;
  path: string;
  entrypoint: "SKILL.md";
  trustLevel: CatalogTrustLevel;
  compatibility: CatalogCompatibility;
  defaultInstall: boolean;
  recommendedForRoles: string[];
  requires: string[];
  tags: string[];
  files: CatalogSkillFile[];
  contentHash: string;
  source?: CatalogSkillSource;
}

export interface CatalogManifest {
  schemaVersion: 1;
  packageName: "@paperclipai/skills-catalog";
  packageVersion: string;
  generatedAt: string;
  skills: CatalogSkill[];
}

export interface CatalogValidationResult {
  valid: boolean;
  errors: string[];
  manifest: CatalogManifest;
}
