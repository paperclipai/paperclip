export const TRUST_PRESETS = ["standard", "low_trust_review"] as const;

export type TrustPreset = (typeof TRUST_PRESETS)[number];

export const DEFAULT_TRUST_PRESET = "standard" as const;
export const LOW_TRUST_REVIEW_PRESET = "low_trust_review" as const;
export const LOW_TRUST_REVIEW_PRESET_VERSION = 1 as const;
export const LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION = "quarantine" as const;

export const LOW_TRUST_TOOL_CLASSES = [
  "git.read",
  "github.pr.read",
  "tests.local",
] as const;

export type LowTrustToolClass = (typeof LOW_TRUST_TOOL_CLASSES)[number] | string;

export interface LowTrustOutputPromotionTarget {
  type: "issue";
  issueId: string;
}

export interface LowTrustBoundary {
  mode: typeof LOW_TRUST_REVIEW_PRESET;
  companyId?: string;
  projectIds?: string[];
  rootIssueId?: string;
  issueIds?: string[];
  allowedAgentIds?: string[];
  allowedSecretBindingIds?: string[];
  allowedToolClasses?: LowTrustToolClass[];
  outputPromotionTarget?: LowTrustOutputPromotionTarget;
}

export interface LowTrustReviewPresetPolicy {
  id: typeof LOW_TRUST_REVIEW_PRESET;
  version: typeof LOW_TRUST_REVIEW_PRESET_VERSION;
  rawOutputDisposition: typeof LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION;
}

export interface AssignmentAuthorizationPolicy extends Record<string, unknown> {
  mode?: "company_default" | "protected";
  /** @deprecated Use `protectedAgent.blockAssignment`. */
  protectedAgentRequiresApproval?: boolean;
}

export interface ProtectedAgentAuthorizationPolicy extends Record<string, unknown> {
  /** Hard-block assignment until a company administrator removes the block. */
  blockAssignment?: boolean;
  blockReason?: string;
  /** @deprecated Legacy hard-block alias. This does not create an approval. */
  requiresApproval?: boolean;
  /** @deprecated Legacy metadata retained for compatibility. */
  approvalReason?: string;
}

export interface TrustAuthorizationPolicy extends Record<string, unknown> {
  trustPreset?: TrustPreset;
  reviewPreset?: LowTrustReviewPresetPolicy;
  trustBoundary?: LowTrustBoundary;
  assignmentPolicy?: AssignmentAuthorizationPolicy;
  protectedAgent?: ProtectedAgentAuthorizationPolicy;
}

export type SourceTrustArtifactKind = "issue" | "comment" | "document" | "work_product";

export type SourceTrustDisposition = "quarantined" | "promoted";

export interface SourceTrustPromotionSource {
  artifactKind: SourceTrustArtifactKind;
  artifactId: string;
  issueId?: string | null;
}

export interface SourceTrustMetadata {
  preset: TrustPreset;
  disposition: SourceTrustDisposition;
  sourceIssueId?: string | null;
  sourceRunId?: string | null;
  sourceAgentId?: string | null;
  promotedFrom?: SourceTrustPromotionSource | null;
  promotedByActorType?: "agent" | "user" | "system" | null;
  promotedByActorId?: string | null;
  promotedAt?: string | null;
}
