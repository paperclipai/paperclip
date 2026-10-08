import type { CompanySkill } from './company-skill.js';

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
  repositoryId: string | null;
  repositoryUrl: string;
  fullName: string;
  trackingRef: string;
  connectionId: string | null;
  excludedFolders: string[];
  enabled: boolean;
  revision: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastScanCommit: string | null;
  lastError: string | null;
  entries: SkillSourceEntry[];
}
export interface SkillSourceDiscoveryRequest {
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
  /** Caller-authorized connection actually used; omitted by older servers. */
  connectionId?: string | null;
  repositoryId: string;
  repositoryUrl: string;
  fullName: string;
  trackingRef: string;
  commitSha: string;
  candidates: SkillSourceCandidate[];
  warnings: string[];
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
}
export interface SkillSourceSelectionRequest {
  revision: number;
  selectedPaths: string[];
  excludedFolders: string[];
  connectionId?: string | null;
}
export interface SkillSourceRefreshResult {
  source: SkillSource;
  imported: CompanySkill[];
  updated: CompanySkill[];
  unchanged: number;
  warnings: string[];
}
