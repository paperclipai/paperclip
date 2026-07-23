import type { IssueAttachment, IssueDocument } from "./issue.js";
import type { IssueWorkProduct } from "./work-product.js";

export type CompanySkillSourceType = "local_path" | "github" | "url" | "catalog" | "skills_sh";

export type CompanySkillTrustLevel = "markdown_only" | "assets" | "scripts_executables";

export type CompanySkillCompatibility = "compatible" | "unknown" | "invalid";

export type CompanySkillSourceBadge = "paperclip" | "github" | "local" | "url" | "catalog" | "skills_sh";

export type CompanySkillSharingScope = "private" | "company" | "public_link";

export type CompanySkillListSort = "alphabetical" | "recent" | "installs" | "stars" | "agents" | "forks";

export type CompanySkillListInclude = "lastEditor";

export interface CompanySkillLastEditor {
  kind: "user" | "agent";
  id: string;
  name: string | null;
  imageUrl: string | null;
}

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
  folderId?: string | null;
  folderPath?: string | null;
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
  folderId?: string | null;
  folderPath?: string | null;
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
  lastEditor?: CompanySkillLastEditor | null;
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
  include?: CompanySkillListInclude[];
  folderId?: string;
  includeSubtree?: boolean;
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
  mode?: "import" | "preview";
  selection?: Array<{
    workspaceId: string;
    path: string;
    slug?: string;
  }>;
}

export type CompanySkillProjectScanCandidateStatus = "new" | "already_imported" | "conflict" | "skipped";

export interface CompanySkillProjectScanCandidate {
  slug: string;
  name: string;
  description: string | null;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  directoryRoot: string;
  relativePath: string;
  status: CompanySkillProjectScanCandidateStatus;
  existingSkillId?: string;
  reason?: string;
}

export interface CompanySkillProjectScanSkipped {
  projectId: string | null;
  projectName: string | null;
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
  candidates: CompanySkillProjectScanCandidate[];
  warnings: string[];
}

export interface CompanySkillCreateRequest {
  folderId?: string | null;
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

export interface CompanySkillFileDeleteRequest {
  path: string;
  target: "file" | "folder";
}

export interface CompanySkillFileDeleteResult {
  skillId: string;
  path: string;
  target: "file" | "folder";
  deletedPaths: string[];
}

export type CompanySkillTestRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface CompanySkillTestInput {
  id: string;
  companyId: string;
  skillId: string;
  name: string;
  content: string;
  createdBy: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySkillTestInputCreateRequest {
  name: string;
  content: string;
}

export interface CompanySkillTestInputUpdateRequest {
  name?: string;
  content?: string;
}

export interface CompanySkillTestRunTemplate {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  body: string;
  builtIn: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanySkillTestRunTemplateCreateRequest {
  name: string;
  description?: string | null;
  body: string;
}

export interface CompanySkillTestRunTemplateUpdateRequest {
  name?: string;
  description?: string | null;
  body?: string;
}

export interface CompanySkillTestRunTemplateSnapshot {
  templateId: string | null;
  templateName: string | null;
  templateBody: string | null;
}

export interface CompanySkillTestRunCostSummary {
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CompanySkillTestRun {
  id: string;
  companyId: string;
  skillId: string;
  inputId: string | null;
  inputSnapshot: string;
  skillVersionId: string;
  agentId: string;
  agentConfigSnapshot: Record<string, unknown>;
  issueId: string;
  templateId: string | null;
  templateName: string | null;
  templateBody: string | null;
  renderedTemplateBody: string | null;
  harnessIssueDescription: string;
  status: CompanySkillTestRunStatus;
  outputDocumentKey: string;
  outputSnapshot: string;
  error: string | null;
  deletedAt: Date | null;
  supersededAt: Date | null;
  harnessIssueExpiresAt: Date | null;
  harnessIssueDeletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cost: CompanySkillTestRunCostSummary;
  taskExpired: boolean;
}

export interface CompanySkillTestRunCreateRequest {
  inputId?: string | null;
  content?: string | null;
  agentId: string;
  /**
   * Omitted uses the built-in default template, null means "No template", and
   * a string selects a built-in or custom template id.
   */
  templateId?: string | null;
  /**
   * Re-run can provide the viewed run's template body snapshot so the new run
   * does not silently pick up later edits to the source template.
   */
  templateSnapshot?: CompanySkillTestRunTemplateSnapshot | null;
  /**
   * Pin a specific skill version for this run instead of the live head. Used by
   * Re-run to reproduce the viewed run's `skillVersionId` snapshot.
   */
  skillVersionId?: string | null;
}

export interface CompanySkillTestRunListQuery {
  inputId?: string;
}

export type CompanySkillTestRunHarnessContentUnavailableReason = "expired" | "deleted" | "missing";

/**
 * Rich renderable content hydrated from the run's own hidden harness issue.
 * When the harness issue has expired or been deleted, `available` is false and
 * the collections are empty; stored run snapshots (input/output/template)
 * remain usable on the run itself.
 */
export interface CompanySkillTestRunHarnessContent {
  available: boolean;
  unavailableReason: CompanySkillTestRunHarnessContentUnavailableReason | null;
  documents: IssueDocument[];
  attachments: IssueAttachment[];
  workProducts: IssueWorkProduct[];
}

export interface CompanySkillTestRunDetail extends CompanySkillTestRun {
  skillVersion: CompanySkillVersion;
  outputBody: string;
  harnessContent: CompanySkillTestRunHarnessContent;
  harnessIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    hiddenAt: Date | null;
  } | null;
  documents: Array<{
    key: string;
    title: string | null;
    updatedAt: Date;
    body: string;
  }>;
  interactions: Array<{
    id: string;
    kind: string;
    status: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  artifacts: Array<{
    id: string;
    kind: "attachment" | "work_product";
    title: string;
    summary: string | null;
    createdAt: Date;
  }>;
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
