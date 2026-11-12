import type { CompanySkill } from './company-skill.js';

export type SkillSourcePackageMode = 'skills' | 'repository';

/**
 * Audit codes an administrator may accept for one repository commit. They flag
 * suspicious patterns (for example `eval` or `curl | sh` in instructions), not
 * confirmed harm. Every other blocking code, such as credential exfiltration,
 * path traversal, or symlinks, can never be overridden.
 */
export const SKILL_SECURITY_OVERRIDABLE_CODES = ['remote_fetch_exec'] as const;
export type SkillSecurityOverridableCode = typeof SKILL_SECURITY_OVERRIDABLE_CODES[number];
export function isSkillSecurityOverridableCode(code: string): code is SkillSecurityOverridableCode {
  return (SKILL_SECURITY_OVERRIDABLE_CODES as readonly string[]).includes(code);
}

/** A file a repository scan left out because of a blocking audit finding. */
export interface SkillSecurityFinding {
  /** Repository-relative path. */
  path: string;
  code: string;
  message: string;
  /** SHA-256 of the exact file bytes at the scanned commit. */
  sha256: string;
  /** False for real risks (for example credential exfiltration); those always stay blocked. */
  overridable: boolean;
  /** True when a recorded administrator override already includes this file. */
  accepted?: boolean;
}

/** An administrator's request to include flagged files from one reviewed commit. */
export interface SkillSecurityOverrideRequest {
  commitSha: string;
  files: Array<{ path: string; sha256: string }>;
  reason: string;
  /** Opt-in: keep trusting these paths in later commits, even when their content changes. */
  trustFutureUpdates: boolean;
}

/** The recorded override a source applies on refresh. Grants file inclusion only, never execution. */
export interface SkillSourceSecurityOverride {
  commitSha: string;
  files: Array<{ path: string; code: string; sha256: string }>;
  reason: string;
  trustFutureUpdates: boolean;
  approvedByUserId: string | null;
  approvedAt: string;
}
/** What a source response shows about its saved approval. The approved files stay on the server. */
export interface SkillSourceSecurityOverrideSummary extends Omit<SkillSourceSecurityOverride, 'files'> {
  fileCount: number;
}
export interface SkillRepositoryPackage {
  files: SkillPackageFile[];
  requirements: string | null;
  /** Author-declared public entrypoints; omitted when no manifest exists. */
  skillPaths?: string[];
  error: string | null;
  warnings: string[];
}

/** Metadata from an audited, immutable repository scan; file contents are fetched on demand. */
export interface SkillPackageInspection {
  /** Commit of this manifest, retained when a package disappears on a later refresh. */
  commitSha?: string;
  files: SkillPackageFile[];
  requirements: string | null;
  references: SkillPackageReference[];
  warnings: string[];
}
export interface SkillPackageFile {
  path: string;
  kind: string;
  sizeBytes: number;
  encoding: 'utf8' | 'base64';
  executable: boolean;
}
export interface SkillPackageReference {
  fromPath: string;
  target: string;
  resolvedPath: string;
  kind: 'missing' | 'outside_package';
}
export interface SkillSourcePreviewRequest extends SkillSourceDiscoveryRequest {
  commitSha: string;
  skillPath: string;
  filePath: string;
}
export interface SkillSourceFilePreview {
  file: SkillPackageFile;
  content: string | null;
  truncated: boolean;
  commitSha: string;
}
/** One file that differs between the installed and latest tracked source revisions. */
export interface SkillSourceUpdateDiffFile {
  path: string;
  /** `not_compared`: the scan left this path out of at least one revision (too large, a symlink, or rejected by the audit). */
  change: 'added' | 'removed' | 'modified' | 'not_compared';
  binary: boolean;
  /** The file's executable bit differs between the two revisions. */
  executableChanged: boolean;
  /** Unified line diff ("-" installed, "+" latest); "" when only the executable bit changed; null when unavailable. */
  diff: string | null;
  /** Why `diff` is null: binary content, a file too large to diff, a path left out of a snapshot, or the response budget ran out. */
  diffUnavailable: 'binary' | 'too_large' | 'omitted' | 'budget' | null;
}
export interface SkillSourceUpdateDiff {
  supported: boolean;
  reason: string | null;
  currentRef: string | null;
  latestRef: string | null;
  /** False when the installed revision is already the latest one. */
  hasUpdate: boolean;
  files: SkillSourceUpdateDiffFile[];
  /** Some files were not listed or carry no diff because the response reached its size or work budget. */
  truncated: boolean;
}
export interface SkillSourceEntry {
  id: string;
  sourceId: string;
  inspection?: SkillPackageInspection | null;
  path: string;
  name: string;
  description: string | null;
  skillId: string | null;
  selection: 'selected' | 'excluded' | 'new';
  present: boolean;
  error: string | null;
}
export interface SkillSource {
  id: string;
  companyId: string;
  packageMode?: SkillSourcePackageMode;
  repositoryPackage?: SkillRepositoryPackage | null;
  repositoryId: string | null;
  repositoryUrl: string;
  fullName: string;
  trackingRef: string;
  connectionId: string | null;
  excludedFolders: string[];
  enabled: boolean;
  automaticUpdates?: boolean;
  importNewSkills?: boolean;
  accessScope?: 'company' | 'projects';
  trackingActive?: boolean;
  syncState?: 'pending' | 'refreshing' | 'ready' | 'error' | 'paused';
  projects?: Array<{ id: string; name: string; visibility: 'open' | 'private'; active: boolean }>;
  revision: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastScanCommit: string | null;
  lastError: string | null;
  repairAction?: 'connection' | 'branch' | 'retry' | null;
  securityOverride?: SkillSourceSecurityOverrideSummary | null;
  entries: SkillSourceEntry[];
}
export interface SkillSourceSettingsRequest {
  revision: number;
  automaticUpdates?: boolean;
  importNewSkills?: boolean;
  connectionId?: string | null;
  /** Follow this branch/ref, or HEAD for the default branch. Version pins remain intact. */
  trackingRef?: string;
}
export interface SkillSourceBranchesQuery { connectionId?: string }
export interface SkillSourceBranches {
  defaultBranch: string;
  branches: Array<{ name: string; isDefault: boolean }>;
  /** The bounded list may omit branches; an unlisted name can still be entered. */
  truncated: boolean;
}
export interface ProjectSkillRepository {
  projectId: string;
  projectName: string;
  projectVisibility: 'open' | 'private';
  workspaceId: string;
  repositoryUrl: string;
  trackingRef: string;
  bindingId: string | null;
  sourceId: string | null;
  status: 'available' | 'pending' | 'ready' | 'error';
  importState?: 'queued' | 'importing';
  lastError: string | null;
}
export interface SkillSourceDiscoveryRequest {
  packageMode?: SkillSourcePackageMode;
  repositoryUrl: string;
  trackingRef?: string;
  connectionId?: string | null;
}
export interface SkillSourceCandidate {
  inspection?: SkillPackageInspection | null;
  path: string;
  name: string;
  description: string | null;
  fileCount: number;
  error: string | null;
  warnings: string[];
}
export interface SkillSourceDiscovery {
  packageMode?: SkillSourcePackageMode;
  repositoryPackage?: SkillRepositoryPackage | null;
  /** Caller-authorized connection actually used; omitted by older servers. */
  connectionId?: string | null;
  repositoryId: string;
  repositoryUrl: string;
  fullName: string;
  trackingRef: string;
  commitSha: string;
  candidates: SkillSourceCandidate[];
  warnings: string[];
  /** Files left out by blocking audit findings at this commit; omitted by older servers. */
  securityFindings?: SkillSecurityFinding[];
  /** Whether this caller may approve a security override; omitted by older servers. */
  canOverrideSecurity?: boolean;
}
/** Live scan metadata only. A complete event is required before selections can be imported. */
export interface SkillSourceScanProgress {
  type: 'progress';
  phase: 'connecting' | 'downloading' | 'listing' | 'checking';
  download?: { stage: 'receiving' | 'resolving'; percent: number; receivedBytes?: number };
  totalSkills: number | null;
  checkedSkills: number;
  currentPath: string | null;
  checkedFiles: number;
  totalFiles: number | null;
}
export type SkillSourceScanUpdate = SkillSourceScanProgress | {
  type: 'candidate';
  candidate: Pick<SkillSourceCandidate, 'path' | 'name' | 'description' | 'fileCount' | 'error'>;
};
/** Newline-delimited JSON, selected with Accept: application/x-ndjson. */
export type SkillSourceDiscoveryEvent = SkillSourceScanUpdate
  | { type: 'complete'; discovery: SkillSourceDiscovery }
  | { type: 'error'; error: string; status: number };

export interface SkillSourceCreateRequest extends SkillSourceDiscoveryRequest {
  commitSha: string;
  selectedPaths: string[];
  excludedFolders?: string[];
  securityOverride?: SkillSecurityOverrideRequest;
}
export interface SkillSourceSelectionRequest {
  packageMode?: SkillSourcePackageMode;
  revision: number;
  selectedPaths: string[];
  excludedFolders: string[];
  connectionId?: string | null;
  /** A new approval replaces the saved one; null withdraws the saved approval. */
  securityOverride?: SkillSecurityOverrideRequest | null;
}
export interface SkillSourceRefreshResult {
  source: SkillSource;
  imported: CompanySkill[];
  updated: CompanySkill[];
  unchanged: number;
  warnings: string[];
}

export interface SkillSourceDisconnectRequest {
  revision: number;
  skills: 'copy' | 'delete';
}
export interface SkillSourceDisconnectResult {
  id: string;
  copiedCount: number;
  deletedCount: number;
}
