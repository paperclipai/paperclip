import {
  DEFAULT_TRUST_PRESET,
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_PRESET_VERSION,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  type AgentPermissions,
  type LowTrustBoundary,
  type SourceTrustMetadata,
  type TrustAuthorizationPolicy,
  type TrustPreset,
} from "@paperclipai/shared";

export type LowTrustBoundaryTarget =
  | { type: "project"; id: string }
  | { type: "root_issue"; id: string }
  | { type: "issue"; id: string };

export const TRUST_PRESET_LABELS: Record<TrustPreset, string> = {
  standard: "Standard",
  low_trust_review: "Low-trust review",
};

export const TRUST_PRESET_DESCRIPTIONS: Record<TrustPreset, string> = {
  standard: "Company-visible collaboration. This is the default for normal work.",
  low_trust_review:
    "Contained for hostile or untrusted input. Narrow Paperclip API, quarantined output. Use for PR review and external-content triage.",
};

export function getTrustPreset(permissions: Partial<AgentPermissions> | null | undefined): TrustPreset {
  return permissions?.trustPreset === LOW_TRUST_REVIEW_PRESET ? LOW_TRUST_REVIEW_PRESET : DEFAULT_TRUST_PRESET;
}

export function buildLowTrustReviewPolicy(
  existing: TrustAuthorizationPolicy | null | undefined,
): TrustAuthorizationPolicy {
  return {
    ...(existing ?? {}),
    trustPreset: LOW_TRUST_REVIEW_PRESET,
    reviewPreset: {
      id: LOW_TRUST_REVIEW_PRESET,
      version: LOW_TRUST_REVIEW_PRESET_VERSION,
      rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
    },
  };
}

export function buildPermissionsForTrustPreset(
  permissions: Partial<AgentPermissions> | null | undefined,
  preset: TrustPreset,
): Partial<AgentPermissions> {
  const current = permissions ?? {};
  if (preset === LOW_TRUST_REVIEW_PRESET) {
    return {
      ...current,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: buildLowTrustReviewPolicy(current.authorizationPolicy),
    };
  }

  const nextPolicy = { ...(current.authorizationPolicy ?? {}) } as TrustAuthorizationPolicy;
  delete nextPolicy.trustPreset;
  delete nextPolicy.reviewPreset;
  delete nextPolicy.trustBoundary;

  return {
    ...current,
    trustPreset: DEFAULT_TRUST_PRESET,
    ...(Object.keys(nextPolicy).length > 0
      ? { authorizationPolicy: nextPolicy }
      : { authorizationPolicy: undefined }),
  };
}

export function getLowTrustBoundary(
  permissions: Partial<AgentPermissions> | null | undefined,
): LowTrustBoundary | null {
  const boundary = permissions?.authorizationPolicy?.trustBoundary;
  return boundary?.mode === LOW_TRUST_REVIEW_PRESET ? boundary : null;
}

function countBoundaryTargets(boundary: LowTrustBoundary | null | undefined) {
  return (
    (boundary?.projectIds?.length ?? 0) +
    (boundary?.rootIssueId ? 1 : 0) +
    (boundary?.issueIds?.length ?? 0)
  );
}

export function getSingleLowTrustBoundaryTarget(
  boundary: LowTrustBoundary | null | undefined,
): LowTrustBoundaryTarget | null {
  if (!boundary || countBoundaryTargets(boundary) !== 1) return null;
  const projectId = boundary.projectIds?.[0];
  if (projectId) return { type: "project", id: projectId };
  if (boundary.rootIssueId) return { type: "root_issue", id: boundary.rootIssueId };
  const issueId = boundary.issueIds?.[0];
  if (issueId) return { type: "issue", id: issueId };
  return null;
}

export function isCeLowTrustBoundaryEditable(boundary: LowTrustBoundary | null | undefined) {
  return countBoundaryTargets(boundary) <= 1;
}

export function setSingleLowTrustBoundaryTarget(
  permissions: Partial<AgentPermissions> | null | undefined,
  companyId: string,
  target: LowTrustBoundaryTarget,
): Partial<AgentPermissions> {
  const current = buildPermissionsForTrustPreset(permissions, LOW_TRUST_REVIEW_PRESET);
  const currentPolicy = current.authorizationPolicy ?? {};
  const existingBoundary = currentPolicy.trustBoundary ?? { mode: LOW_TRUST_REVIEW_PRESET };
  const { projectIds: _projectIds, rootIssueId: _rootIssueId, issueIds: _issueIds, ...nonScopeBoundary } = existingBoundary;
  const trustBoundary: LowTrustBoundary = {
    ...nonScopeBoundary,
    mode: LOW_TRUST_REVIEW_PRESET,
    companyId,
    ...(target.type === "project" ? { projectIds: [target.id] } : {}),
    ...(target.type === "root_issue" ? { rootIssueId: target.id } : {}),
    ...(target.type === "issue" ? { issueIds: [target.id] } : {}),
  };

  return {
    ...current,
    authorizationPolicy: {
      ...currentPolicy,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      reviewPreset: {
        id: LOW_TRUST_REVIEW_PRESET,
        version: LOW_TRUST_REVIEW_PRESET_VERSION,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
      },
      trustBoundary,
    },
  };
}

export function clearSingleLowTrustBoundaryTarget(
  permissions: Partial<AgentPermissions> | null | undefined,
): Partial<AgentPermissions> {
  const current = buildPermissionsForTrustPreset(permissions, LOW_TRUST_REVIEW_PRESET);
  const currentPolicy = current.authorizationPolicy ?? {};
  const boundary = currentPolicy.trustBoundary;
  if (!boundary) return current;
  const { projectIds: _projectIds, rootIssueId: _rootIssueId, issueIds: _issueIds, ...nonScopeBoundary } = boundary;
  return {
    ...current,
    authorizationPolicy: {
      ...currentPolicy,
      trustBoundary: {
        ...nonScopeBoundary,
        mode: LOW_TRUST_REVIEW_PRESET,
      },
    },
  };
}

export function summarizeLowTrustBoundaryTarget(
  boundary: LowTrustBoundary | null | undefined,
) {
  const target = getSingleLowTrustBoundaryTarget(boundary);
  if (target?.type === "project") return `Project ${target.id.slice(0, 8)}`;
  if (target?.type === "root_issue") return `Root issue ${target.id.slice(0, 8)}`;
  if (target?.type === "issue") return `Issue ${target.id.slice(0, 8)}`;
  if (!boundary || countBoundaryTargets(boundary) === 0) return "No boundary selected";
  return `${countBoundaryTargets(boundary)} boundaries`;
}

export function lowTrustBoundaryHasScope(boundary: LowTrustBoundary | null | undefined) {
  return countBoundaryTargets(boundary) > 0;
}

export function sourceTrustLabel(sourceTrust: SourceTrustMetadata | null | undefined) {
  if (!sourceTrust || sourceTrust.preset !== LOW_TRUST_REVIEW_PRESET) return null;
  if (sourceTrust.disposition === "promoted") return "Promoted from low-trust";
  return "Low-trust source";
}
