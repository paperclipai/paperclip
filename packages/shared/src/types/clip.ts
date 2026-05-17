export const CLIP_TYPES = ["team", "agent", "skill", "routine", "bundle"] as const;
export type ClipType = (typeof CLIP_TYPES)[number];

export const CLIP_VISIBILITIES = ["private_share", "unlisted", "public"] as const;
export type ClipVisibility = (typeof CLIP_VISIBILITIES)[number];

export const CLIP_STATUSES = ["draft", "pending_review", "published", "delisted", "archived"] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

export const CLIP_MODERATION_STATES = ["normal", "under_review", "warning", "limited", "blocked", "delisted"] as const;
export type ClipModerationState = (typeof CLIP_MODERATION_STATES)[number];

export const CLIP_SECURITY_REVIEW_STATES = ["unreviewed", "automated_checked", "security_reviewed", "blocked"] as const;
export type ClipSecurityReviewState = (typeof CLIP_SECURITY_REVIEW_STATES)[number];

export const CLIP_VERIFICATION_STATES = ["not_run", "passed", "failed", "stale"] as const;
export type ClipVerificationState = (typeof CLIP_VERIFICATION_STATES)[number];

export const CLIP_DEPENDENCY_TYPES = ["adapter", "plugin", "skill", "secret", "permission", "runtime", "workspace"] as const;
export type ClipDependencyType = (typeof CLIP_DEPENDENCY_TYPES)[number];

export const CLIP_DEPENDENCY_REQUIREMENTS = ["required", "optional"] as const;
export type ClipDependencyRequirement = (typeof CLIP_DEPENDENCY_REQUIREMENTS)[number];

export const CLIP_COMMENT_CATEGORIES = [
  "question",
  "bug",
  "integration_help",
  "use_case_report",
  "security_concern",
  "maintainer_note",
] as const;
export type ClipCommentCategory = (typeof CLIP_COMMENT_CATEGORIES)[number];

export const CLIP_VOTE_VALUES = ["up", "down"] as const;
export type ClipVoteValue = (typeof CLIP_VOTE_VALUES)[number];

export const CLIP_REPORT_REASONS = [
  "malicious_instructions",
  "credential_theft",
  "unsafe_automation",
  "spam",
  "copyright",
  "misleading_metadata",
  "broken_install",
  "impersonation",
  "other",
] as const;
export type ClipReportReason = (typeof CLIP_REPORT_REASONS)[number];

export const CLIP_IMPORT_STATUSES = [
  "previewed",
  "applied",
  "failed",
  "rolled_back",
  "update_available",
  "superseded",
] as const;
export type ClipImportStatus = (typeof CLIP_IMPORT_STATUSES)[number];

export interface ClipCreatorProfile {
  id: string;
  companyId: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  websiteUrl: string | null;
  verificationState: string;
  reputationSummary: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ClipDependency {
  id: string;
  clipId: string;
  revisionId: string;
  type: ClipDependencyType;
  key: string;
  displayName: string | null;
  required: ClipDependencyRequirement;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
}

export interface ClipRevision {
  id: string;
  clipId: string;
  revisionNumber: number;
  manifestVersion: string;
  manifestChecksum: string;
  artifactChecksum: string;
  manifestPayload: Record<string, unknown>;
  artifactRef: Record<string, unknown> | null;
  dependencyGraph: Record<string, unknown>;
  permissions: Record<string, unknown>[];
  secretsSchema: Record<string, unknown>[];
  budgetEstimate: Record<string, unknown> | null;
  redactionReport: Record<string, unknown>;
  dangerousCapabilities: string[];
  securityReviewState: ClipSecurityReviewState;
  verificationState: ClipVerificationState;
  compatibility: Record<string, unknown>;
  changeSummary: string | null;
  breakingChanges: string | null;
  migrationNotes: string | null;
  createdAt: Date | string;
}

export interface PublicClip {
  id: string;
  slug: string;
  type: ClipType;
  title: string;
  summary: string;
  description: string | null;
  visibility: ClipVisibility;
  status: ClipStatus;
  moderationState: ClipModerationState;
  currentRevisionId: string | null;
  latestApprovedRevisionId: string | null;
  creatorProfileId: string;
  creator: Pick<ClipCreatorProfile, "id" | "handle" | "displayName" | "avatarUrl" | "verificationState" | "reputationSummary">;
  tags: string[];
  categories: string[];
  useCases: string[];
  requiredProviders: string[];
  compatibility: Record<string, unknown>;
  metrics: {
    importCount: number;
    successfulFirstRunCount: number;
    voteScore: number;
    upvoteCount: number;
    downvoteCount: number;
    commentCount: number;
    showcaseCount: number;
    reportCount: number;
  };
  currentRevision?: ClipRevision | null;
  dependencies?: ClipDependency[];
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ClipSharePreviewRequest {
  source: {
    type: ClipType;
    id: string;
  };
  title?: string;
  summary?: string;
  slug?: string;
  visibility?: ClipVisibility;
  revisionNote?: string | null;
}

export interface ClipSharePreviewResult {
  source: {
    type: ClipType;
    id: string;
    label: string;
  };
  publishRequest: Record<string, unknown>;
  exportPreview: Record<string, unknown>;
  manifest: Record<string, unknown>;
  dependencyCounts: {
    adapters: number;
    plugins: number;
    skills: number;
    secrets: number;
    permissions: number;
    workspaces: number;
  };
  redactionSummary: {
    allowed: number;
    redacted: number;
    summarized: number;
    omitted: number;
  };
  dangerousCapabilities: string[];
  warnings: string[];
}

export interface ClipImportPreviewRequest {
  url: string;
  collisionStrategy?: "rename" | "skip";
}

export interface ClipImportPreviewResult {
  clip: PublicClip;
  preview: Record<string, unknown>;
  safety: {
    dangerousCapabilities: string[];
    requiredSecrets: string[];
    permissions: string[];
    routineTriggersEnabledByDefault: boolean;
    webhookSecretsRegenerated: boolean;
  };
  source: {
    url: string;
    revisionNumber: number;
    manifestChecksum: string;
    artifactChecksum: string;
  };
}

export interface ClipImportApplyRequest extends ClipImportPreviewRequest {
  selectedOptions?: Record<string, unknown>;
}

export interface ClipImportApplyResult {
  importResult: Record<string, unknown>;
  clip: PublicClip;
  source: ClipImportPreviewResult["source"];
}
