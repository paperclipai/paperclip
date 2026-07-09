export type CompanySkillSourceType = "local_path" | "github" | "url" | "catalog" | "skills_sh";

export type CompanySkillTrustLevel = "markdown_only" | "assets" | "scripts_executables";

export type CompanySkillCompatibility = "compatible" | "unknown" | "invalid";

export type CompanySkillSourceBadge = "paperclip" | "github" | "local" | "url" | "catalog" | "skills_sh";

export type CompanySkillSharingScope = "private" | "company" | "public_link";

export type CompanySkillListSort = "alphabetical" | "recent" | "installs" | "stars" | "agents" | "forks";

export interface CompanySkillFileInventoryEntry {
  path: string;
  kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other";
}

export interface CompanySkillVersionFileInventoryEntry extends CompanySkillFileInventoryEntry {
  content: string;
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
  iconUrl: string | null;
  color: string | null;
  tagline: string | null;
  authorName: string | null;
  homepageUrl: string | null;
  categories: string[];
  sharingScope: CompanySkillSharingScope;
  publicShareToken: string | null;
  forkedFromSkillId: string | null;
  forkedFromCompanyId: string | null;
  starCount: number;
  installCount: number;
  forkCount: number;
  currentVersionId: string | null;
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
  iconUrl: string | null;
  color: string | null;
  tagline: string | null;
  authorName: string | null;
  homepageUrl: string | null;
  categories: string[];
  sharingScope: CompanySkillSharingScope;
  publicShareToken: string | null;
  forkedFromSkillId: string | null;
  forkedFromCompanyId: string | null;
  starCount: number;
  installCount: number;
  forkCount: number;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  attachedAgentCount: number;
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
  catalogKind: "bundled" | "optional" | null;
  originHash: string | null;
  packageName: string | null;
  packageVersion: string | null;
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
  versionId: string | null;
}

export interface CompanySkillDetail extends CompanySkill {
  attachedAgentCount: number;
  usedByAgents: CompanySkillUsageAgent[];
  existingForks: CompanySkillForkSummary[];
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
  currentVersion: CompanySkillVersion | null;
  starredByCurrentActor: boolean;
}

export interface CompanySkillListQuery {
  q?: string;
  sort?: CompanySkillListSort;
  categories?: string[];
  scope?: CompanySkillSharingScope;
}

export interface CompanySkillCategoryCount {
  slug: string;
  count: number;
}

export interface CompanySkillVersion {
  id: string;
  companyId: string;
  companySkillId: string;
  revisionNumber: number;
  label: string | null;
  fileInventory: CompanySkillVersionFileInventoryEntry[];
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date;
}

export interface CompanySkillVersionCreateRequest {
  label?: string | null;
}

export interface CompanySkillStarResult {
  skillId: string;
  starred: boolean;
  starCount: number;
}

export interface CompanySkillComment {
  id: string;
  companyId: string;
  companySkillId: string;
  parentCommentId: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySkillCommentCreateRequest {
  body: string;
  parentCommentId?: string | null;
}

export interface CompanySkillCommentUpdateRequest {
  body: string;
}

export interface CompanySkillForkRequest {
  name?: string | null;
  slug?: string | null;
  sharingScope?: CompanySkillSharingScope;
  reassignAgentIds?: string[];
}

export interface CompanySkillOriginalSummary {
  id: string;
  name: string;
  slug: string;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
}

export interface CompanySkillForkSummary extends CompanySkillOriginalSummary {
  key: string;
  forkedFromSkillId: string | null;
  forkedFromCompanyId: string | null;
  currentVersionId: string | null;
  createdByCurrentActor: boolean;
  diverged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySkillForkReassignment {
  agentId: string;
  previousSkillKey: string;
  nextSkillKey: string;
}

export interface CompanySkillForkResult {
  skill: CompanySkill;
  original: CompanySkillOriginalSummary;
  reassignments: CompanySkillForkReassignment[];
}

export interface CompanySkillForkPrecheckResult {
  skillId: string;
  original: CompanySkillOriginalSummary;
  agentUsageCount: number;
  usedByAgents: CompanySkillUsageAgent[];
  existingForks: CompanySkillForkSummary[];
}

export interface CompanySkillUpdateRequest {
  description?: string | null;
  iconUrl?: string | null;
  color?: string | null;
  tagline?: string | null;
  authorName?: string | null;
  homepageUrl?: string | null;
  categories?: string[];
  sharingScope?: CompanySkillSharingScope;
}

export interface CompanySkillUpdateStatus {
  supported: boolean;
  reason: string | null;
  trackingRef: string | null;
  currentRef: string | null;
  latestRef: string | null;
  hasUpdate: boolean;
  installedHash: string | null;
  originHash: string | null;
  userModifiedAt: string | null;
  updateHoldReason: CompanySkillUpdateHoldReason | null;
  auditVerdict: CompanySkillAuditVerdict | null;
  auditCodes: string[];
}

export type CompanySkillAuditSeverity = "warning" | "error";

export type CompanySkillAuditVerdict = "pass" | "warning" | "fail";

export type CompanySkillUpdateHoldReason =
  | "local_modifications"
  | "audit_hard_stop"
  | "origin_unavailable"
  | "compatibility_invalid"
  | "operator_hold";

export interface CompanySkillAuditFinding {
  code: string;
  severity: CompanySkillAuditSeverity;
  message: string;
  path: string | null;
}

export interface CompanySkillAuditResult {
  skillId: string;
  installedHash: string | null;
  originHash: string | null;
  verdict: CompanySkillAuditVerdict;
  codes: string[];
  findings: CompanySkillAuditFinding[];
  scannedAt: string;
  scanVersion: string;
}

export interface CompanySkillInstallUpdateRequest {
  force?: boolean;
}

export interface CompanySkillResetRequest {
  force?: boolean;
}

export interface CompanySkillImportRequest {
  source: string;
}

export interface CompanySkillImportResult {
  imported: CompanySkill[];
  warnings: string[];
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
  iconUrl?: string | null;
  color?: string | null;
  tagline?: string | null;
  authorName?: string | null;
  homepageUrl?: string | null;
  categories?: string[];
  sharingScope?: CompanySkillSharingScope;
  forkedFromSkillId?: string | null;
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

export type CatalogSkillKind = "bundled" | "optional";

export type CatalogSkillFileKind = CompanySkillFileInventoryEntry["kind"];

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
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  defaultInstall: boolean;
  recommendedForRoles: string[];
  requires: string[];
  tags: string[];
  files: CatalogSkillFile[];
  contentHash: string;
  source?: CatalogSkillSource;
  packageName?: string;
  packageVersion?: string;
}

export interface CatalogSkillListQuery {
  kind?: CatalogSkillKind;
  category?: string;
  q?: string;
}

export interface CatalogSkillFileDetail {
  catalogSkillId: string;
  path: string;
  kind: CatalogSkillFileKind;
  content: string;
  language: string | null;
  markdown: boolean;
}

export interface CompanySkillInstallCatalogRequest {
  catalogSkillId: string;
  slug?: string | null;
  force?: boolean;
}

export interface CompanySkillInstallCatalogResult {
  action: "created" | "updated" | "unchanged";
  skill: CompanySkill;
  catalogSkill: CatalogSkill;
  warnings: string[];
}
