export type CompanySkillSourceType =
  | "local_path"
  | "github"
  | "url"
  | "catalog"
  | "skills_sh"
  | "brabrix_skillhub";

export type CompanySkillImportProvider = "github" | "skills_sh" | "brabrix_skillhub";

export type CompanySkillTrustLevel = "markdown_only" | "assets" | "scripts_executables";

export type CompanySkillCompatibility = "compatible" | "unknown" | "invalid";

export type CompanySkillSourceBadge = "paperclip" | "github" | "local" | "url" | "catalog" | "skills_sh" | "brabrix";

export interface CompanySkillFileInventoryEntry {
  path: string;
  kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other";
}

export interface CompanySkill {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySkillListItem {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  createdAt: Date;
  updatedAt: Date;
  attachedAgentCount: number;
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
}

export interface CompanySkillUsageAgent {
  id: string;
  name: string;
  urlKey: string;
  adapterType: string;
  desired: boolean;
  /**
   * Runtime adapter skill state when a caller explicitly fetched it.
   * Company skill detail reads intentionally return null here to avoid probing
   * agent runtimes while loading operator-facing skill metadata.
   */
  actualState: string | null;
}

export interface CompanySkillDetail extends CompanySkill {
  attachedAgentCount: number;
  usedByAgents: CompanySkillUsageAgent[];
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
}

export interface CompanySkillUpdateStatus {
  supported: boolean;
  reason: string | null;
  trackingRef: string | null;
  currentRef: string | null;
  latestRef: string | null;
  hasUpdate: boolean;
}

export interface CompanySkillImportRequest {
  source?: string;
  provider?: CompanySkillImportProvider;
  skillId?: string;
}

export interface CompanySkillImportResult {
  imported: CompanySkill[];
  warnings: string[];
}

export interface CompanySkillProviderEntry {
  key: CompanySkillImportProvider;
  label: string;
  enabled: boolean;
}

export interface BrabrixSkillHubSkillSummary {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  description: string | null;
  category: string | null;
  tags: string[];
  featured: boolean;
  version: string | null;
  updatedAt: string | null;
  contextSizeChars: number;
}

export interface BrabrixSkillHubCategorySummary {
  key: string;
  label: string;
  description: string | null;
}

export interface BrabrixSkillHubSearchRequest {
  q?: string | null;
  category?: string | null;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface BrabrixSkillHubSearchResponse {
  provider: "brabrix_skillhub";
  skills: BrabrixSkillHubSkillSummary[];
  total: number | null;
}

export interface BrabrixSkillHubFeaturedResponse {
  provider: "brabrix_skillhub";
  skills: BrabrixSkillHubSkillSummary[];
}

export interface BrabrixSkillHubCategoriesResponse {
  provider: "brabrix_skillhub";
  categories: BrabrixSkillHubCategorySummary[];
}

export interface BrabrixSkillHubSettings {
  provider: "brabrix_skillhub";
  apiKeySecretId: string | null;
  credentialSource: "settings" | "env" | "none";
}

export interface BrabrixSkillHubSettingsUpdateRequest {
  apiKeySecretId?: string | null;
}

export interface BrabrixAgentSyncSettings {
  provider: "brabrix_agent_sync";
  agentTokenSecretId: string | null;
  projectIdSecretId: string | null;
  tenantIdSecretId: string | null;
  credentialSource: {
    agentToken: "settings" | "env" | "none";
    projectId: "settings" | "env" | "none";
    tenantId: "settings" | "env" | "none";
  };
  enabled: boolean;
}

export interface BrabrixAgentSyncSettingsUpdateRequest {
  agentTokenSecretId?: string | null;
  projectIdSecretId?: string | null;
  tenantIdSecretId?: string | null;
}

export interface CompanySkillProjectScanRequest {
  projectIds?: string[];
  workspaceIds?: string[];
}

export interface CompanySkillProjectScanSkipped {
  projectId: string;
  projectName: string;
  workspaceId: string | null;
  workspaceName: string | null;
  path: string | null;
  reason: string;
}

export interface CompanySkillProjectScanConflict {
  slug: string;
  key: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
  existingSkillId: string;
  existingSkillKey: string;
  existingSourceLocator: string | null;
  reason: string;
}

export interface CompanySkillProjectScanResult {
  scannedProjects: number;
  scannedWorkspaces: number;
  discovered: number;
  imported: CompanySkill[];
  updated: CompanySkill[];
  skipped: CompanySkillProjectScanSkipped[];
  conflicts: CompanySkillProjectScanConflict[];
  warnings: string[];
}

export interface CompanySkillCreateRequest {
  name: string;
  slug?: string | null;
  description?: string | null;
  markdown?: string | null;
}

export interface CompanySkillFileDetail {
  skillId: string;
  path: string;
  kind: CompanySkillFileInventoryEntry["kind"];
  content: string;
  language: string | null;
  markdown: boolean;
  editable: boolean;
}

export interface CompanySkillFileUpdateRequest {
  path: string;
  content: string;
}
