import type {
  CompanyPortabilityFileEntry,
  CompanyPortabilityManifest,
} from "./company-portability.js";

export type CompanyRolloutEntityKind = "agent" | "skill" | "project" | "routine" | "issue";

export type CompanyRolloutEntityAction =
  | "create"
  | "update"
  | "skip_no_change"
  | "skip_unmanaged_conflict"
  | "error";

export type CompanyRolloutTargetStatus = "previewed" | "applied" | "failed";

export interface CompanyRolloutCounts {
  create: number;
  update: number;
  skipNoChange: number;
  skipUnmanagedConflict: number;
  error: number;
}

export interface CompanyRolloutRelease {
  id: string;
  sourceCompanyId: string;
  version: number;
  title: string;
  notes: string | null;
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  selectedFiles: string[];
  packageHash: string;
  counts: {
    files: number;
    agents: number;
    skills: number;
    projects: number;
    routines: number;
    issues: number;
  };
  createdByUserId: string | null;
  createdAt: Date;
}

export interface CompanyRolloutTargetPreview {
  companyId: string;
  companyName: string;
  companyStatus: string;
  status: CompanyRolloutTargetStatus;
  counts: CompanyRolloutCounts;
  warnings: string[];
  errors: string[];
  entityActions: CompanyRolloutEntityPreview[];
  updatedAt: Date | null;
}

export interface CompanyRolloutEntityPreview {
  kind: CompanyRolloutEntityKind;
  key: string;
  label: string;
  action: CompanyRolloutEntityAction;
  targetEntityId: string | null;
  reason: string | null;
}

export interface CompanyRolloutPreviewResult {
  release: CompanyRolloutRelease;
  targets: CompanyRolloutTargetPreview[];
}

export interface CompanyRolloutApplyTargetResult extends CompanyRolloutTargetPreview {
  applied: boolean;
}

export interface CompanyRolloutApplyResult {
  release: CompanyRolloutRelease;
  targets: CompanyRolloutApplyTargetResult[];
}

export interface CompanyRolloutCreateRequest {
  title: string;
  notes?: string | null;
  selectedFiles?: string[];
}

export interface CompanyRolloutTargetSelectionRequest {
  targetCompanyIds?: string[];
}
