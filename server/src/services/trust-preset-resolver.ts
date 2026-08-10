import {
  DEFAULT_TRUST_PRESET,
  LOW_TRUST_REVIEW_PRESET,
  type LowTrustBoundary,
  type TrustPreset,
  lowTrustBoundarySchema,
  lowTrustReviewPresetPolicySchema,
  trustAuthorizationPolicySchema,
  trustPresetSchema,
} from "@paperclipai/shared";

type JsonRecord = Record<string, unknown>;

export const LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH = 12;

export type TrustPresetPolicySource = "agent" | "project" | "issue" | "run";

export type ResolveCoreTrustPresetInput = {
  companyId: string;
  agent?: {
    companyId?: string | null;
    permissions?: unknown;
  } | null;
  project?: {
    companyId?: string | null;
    executionWorkspacePolicy?: unknown;
  } | null;
  issue?: {
    companyId?: string | null;
    executionPolicy?: unknown;
  } | null;
  run?: {
    companyId?: string | null;
    executionPolicy?: unknown;
  } | null;
};

export type TrustPresetDenyReason =
  | "unsupported_trust_preset"
  | "invalid_authorization_policy"
  | "invalid_low_trust_boundary"
  | "cross_company_boundary"
  | "conflicting_low_trust_boundary"
  | "missing_low_trust_boundary_scope";

export type TrustPresetResolution =
  | {
    kind: "standard";
    preset: typeof DEFAULT_TRUST_PRESET;
    boundary: null;
    sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>;
  }
  | {
    kind: "low_trust_review";
    preset: typeof LOW_TRUST_REVIEW_PRESET;
    boundary: LowTrustBoundary & { companyId: string };
    sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>;
  }
  | {
    kind: "denied";
    reason: TrustPresetDenyReason;
    source: TrustPresetPolicySource | null;
    detail: string;
    sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>;
  };

type ParsedPolicySource = {
  source: TrustPresetPolicySource;
  companyId: string | null;
  rawPolicy: JsonRecord | null;
  authorizationPolicy: JsonRecord | null;
  trustPreset: TrustPreset | null;
  boundary: LowTrustBoundary | null;
  impliesLowTrust: boolean;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function deny(
  reason: TrustPresetDenyReason,
  source: TrustPresetPolicySource | null,
  detail: string,
  sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>,
): TrustPresetResolution {
  return { kind: "denied", reason, source, detail, sourcePresets };
}

function isTrustPresetResolution(value: unknown): value is TrustPresetResolution {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "standard" || kind === "low_trust_review" || kind === "denied";
}

function parsePreset(
  value: unknown,
  source: TrustPresetPolicySource,
  sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>,
): TrustPresetResolution | TrustPreset | null {
  if (value === undefined || value === null) return null;
  const parsed = trustPresetSchema.safeParse(value);
  if (!parsed.success) {
    return deny(
      "unsupported_trust_preset",
      source,
      `Unsupported trust preset in ${source} policy.`,
      sourcePresets,
    );
  }
  return parsed.data;
}

function parseReviewPresetId(
  value: unknown,
  source: TrustPresetPolicySource,
  sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>,
): TrustPresetResolution | TrustPreset | null {
  if (value === undefined || value === null) return null;
  const parsed = lowTrustReviewPresetPolicySchema.safeParse(value);
  if (!parsed.success) {
    return deny(
      "unsupported_trust_preset",
      source,
      `Unsupported review preset in ${source} policy.`,
      sourcePresets,
    );
  }
  return parsed.data.id;
}

function parseAuthorizationPolicy(
  value: unknown,
  source: TrustPresetPolicySource,
  sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>,
): TrustPresetResolution | JsonRecord | null {
  if (value === undefined || value === null) return null;
  const parsed = trustAuthorizationPolicySchema.safeParse(value);
  if (!parsed.success) {
    return deny(
      "invalid_authorization_policy",
      source,
      `Invalid authorization policy in ${source} policy.`,
      sourcePresets,
    );
  }
  return parsed.data as JsonRecord;
}

function parseBoundary(
  value: unknown,
  source: TrustPresetPolicySource,
  sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>,
): TrustPresetResolution | LowTrustBoundary | null {
  if (value === undefined || value === null) return null;
  const parsed = lowTrustBoundarySchema.safeParse(value);
  if (!parsed.success) {
    return deny(
      "invalid_low_trust_boundary",
      source,
      `Invalid low-trust boundary in ${source} policy.`,
      sourcePresets,
    );
  }
  return parsed.data;
}

function parseSource(
  source: TrustPresetPolicySource,
  companyId: string | null | undefined,
  rawPolicy: JsonRecord | null,
  authorizationPolicyInput: unknown,
  sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>,
): ParsedPolicySource | TrustPresetResolution {
  const topPreset = parsePreset(rawPolicy?.trustPreset, source, sourcePresets);
  if (isTrustPresetResolution(topPreset)) return topPreset;

  const topReviewPreset = parseReviewPresetId(rawPolicy?.reviewPreset, source, sourcePresets);
  if (isTrustPresetResolution(topReviewPreset)) return topReviewPreset;

  const authorizationPolicy = parseAuthorizationPolicy(authorizationPolicyInput, source, sourcePresets);
  if (isTrustPresetResolution(authorizationPolicy)) return authorizationPolicy;

  const authPreset = parsePreset(authorizationPolicy?.trustPreset, source, sourcePresets);
  if (isTrustPresetResolution(authPreset)) return authPreset;

  const authReviewPreset = parseReviewPresetId(authorizationPolicy?.reviewPreset, source, sourcePresets);
  if (isTrustPresetResolution(authReviewPreset)) return authReviewPreset;

  const boundary = parseBoundary(authorizationPolicy?.trustBoundary, source, sourcePresets);
  if (isTrustPresetResolution(boundary)) return boundary;

  const trustPreset = topPreset ?? topReviewPreset ?? authPreset ?? authReviewPreset;
  if (trustPreset) sourcePresets[source] = trustPreset;

  return {
    source,
    companyId: companyId ?? null,
    rawPolicy,
    authorizationPolicy,
    trustPreset,
    boundary,
    impliesLowTrust: trustPreset === LOW_TRUST_REVIEW_PRESET || Boolean(boundary),
  };
}

function normalizeSet(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return [...new Set(values)].sort();
}

function intersectSets(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const normalizedRight = normalizeSet(right);
  if (normalizedRight === undefined) return left;
  const normalizedLeft = normalizeSet(left);
  if (normalizedLeft === undefined) return normalizedRight;
  const rightSet = new Set(normalizedRight);
  return normalizedLeft.filter((value) => rightSet.has(value));
}

function mergeBoundary(
  current: (LowTrustBoundary & { companyId: string }) | null,
  next: LowTrustBoundary,
  companyId: string,
  source: TrustPresetPolicySource,
  sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>>,
): (LowTrustBoundary & { companyId: string }) | TrustPresetResolution {
  if (next.companyId && next.companyId !== companyId) {
    return deny(
      "cross_company_boundary",
      source,
      "Low-trust boundary refers to a different company.",
      sourcePresets,
    );
  }

  const base = current ?? { mode: LOW_TRUST_REVIEW_PRESET, companyId };
  if (base.rootIssueId && next.rootIssueId && base.rootIssueId !== next.rootIssueId) {
    return deny(
      "conflicting_low_trust_boundary",
      source,
      "Low-trust boundary root issue scopes do not overlap.",
      sourcePresets,
    );
  }

  return {
    ...base,
    projectIds: intersectSets(base.projectIds, next.projectIds),
    rootIssueId: base.rootIssueId ?? next.rootIssueId,
    issueIds: intersectSets(base.issueIds, next.issueIds),
    allowedAgentIds: intersectSets(base.allowedAgentIds, next.allowedAgentIds),
    allowedSecretBindingIds: intersectSets(base.allowedSecretBindingIds, next.allowedSecretBindingIds),
    allowedToolClasses: intersectSets(base.allowedToolClasses, next.allowedToolClasses),
    outputPromotionTarget: next.outputPromotionTarget ?? base.outputPromotionTarget,
  };
}

function hasBoundaryScope(boundary: LowTrustBoundary): boolean {
  return Boolean(boundary.rootIssueId)
    || Boolean(boundary.projectIds?.length)
    || Boolean(boundary.issueIds?.length);
}

export function resolveCoreTrustPreset(input: ResolveCoreTrustPresetInput): TrustPresetResolution {
  const sourcePresets: Partial<Record<TrustPresetPolicySource, TrustPreset>> = {};
  const sources: ParsedPolicySource[] = [];

  const agentPermissions = asRecord(input.agent?.permissions);
  const agent = parseSource("agent", input.agent?.companyId, agentPermissions, agentPermissions?.authorizationPolicy, sourcePresets);
  if ("kind" in agent) return agent;
  sources.push(agent);

  const projectPolicy = asRecord(input.project?.executionWorkspacePolicy);
  const project = parseSource("project", input.project?.companyId, projectPolicy, projectPolicy?.authorizationPolicy, sourcePresets);
  if ("kind" in project) return project;
  sources.push(project);

  const issuePolicy = asRecord(input.issue?.executionPolicy);
  const issue = parseSource("issue", input.issue?.companyId, issuePolicy, issuePolicy?.authorizationPolicy, sourcePresets);
  if ("kind" in issue) return issue;
  sources.push(issue);

  const runPolicy = asRecord(input.run?.executionPolicy);
  const run = parseSource("run", input.run?.companyId, runPolicy, runPolicy?.authorizationPolicy, sourcePresets);
  if ("kind" in run) return run;
  sources.push(run);

  for (const source of sources) {
    if (source.companyId && source.companyId !== input.companyId) {
      return deny(
        "cross_company_boundary",
        source.source,
        "Policy source belongs to a different company.",
        sourcePresets,
      );
    }
  }

  const effectivePreset = sources.some((source) => source.impliesLowTrust)
    ? LOW_TRUST_REVIEW_PRESET
    : DEFAULT_TRUST_PRESET;

  if (effectivePreset === DEFAULT_TRUST_PRESET) {
    return {
      kind: "standard",
      preset: DEFAULT_TRUST_PRESET,
      boundary: null,
      sourcePresets,
    };
  }

  let boundary: (LowTrustBoundary & { companyId: string }) | null = null;
  for (const source of sources) {
    if (!source.boundary) continue;
    const merged = mergeBoundary(boundary, source.boundary, input.companyId, source.source, sourcePresets);
    if (isTrustPresetResolution(merged)) return merged;
    boundary = merged;
  }

  if (!boundary || !hasBoundaryScope(boundary)) {
    return deny(
      "missing_low_trust_boundary_scope",
      null,
      "Low-trust review requires a concrete project, root issue, or issue-id boundary.",
      sourcePresets,
    );
  }

  return {
    kind: "low_trust_review",
    preset: LOW_TRUST_REVIEW_PRESET,
    boundary,
    sourcePresets,
  };
}

export function isIssueWithinLowTrustBoundary(
  boundary: LowTrustBoundary & { companyId: string },
  issue: { companyId: string; id?: string | null; projectId?: string | null },
): boolean {
  if (issue.companyId !== boundary.companyId) return false;
  if (issue.id && issue.id === boundary.rootIssueId) return true;
  if (issue.id && boundary.issueIds?.includes(issue.id)) return true;
  if (issue.projectId && boundary.projectIds?.includes(issue.projectId)) return true;
  return false;
}
