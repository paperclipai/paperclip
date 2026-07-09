const GIT_HANDOFF_REFS_METADATA_KEY = "gitHandoffRefs";
const GIT_HANDOFF_REF_PREFIX = "refs/paperclip/handoffs";
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export type GitHandoffRefMetadata = {
  version: 1;
  ref: string;
  sha: string;
  shortSha: string;
  issueId: string | null;
  issueIdentifier: string | null;
  executionWorkspaceId: string | null;
  runId: string | null;
  branchName: string | null;
  baseRef: string | null;
  relatedIssueIds: string[];
  workProductIds: string[];
  signalKinds: string[];
  status: "pending";
  createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(readString).filter((entry): entry is string => Boolean(entry)))];
}

function sanitizeGitRefComponent(value: string | null | undefined, fallback: string): string {
  const sanitized = (value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
  return sanitized || fallback;
}

function normalizeGitHandoffRef(value: unknown): GitHandoffRefMetadata | null {
  if (!isRecord(value)) return null;

  const ref = readString(value.ref);
  const sha = readString(value.sha);
  if (!ref || !sha || !FULL_SHA_RE.test(sha)) return null;
  if (!ref.startsWith(`${GIT_HANDOFF_REF_PREFIX}/`)) return null;

  const createdAt = readString(value.createdAt) ?? new Date(0).toISOString();
  return {
    version: 1,
    ref,
    sha,
    shortSha: readString(value.shortSha) ?? sha.slice(0, 12),
    issueId: readString(value.issueId),
    issueIdentifier: readString(value.issueIdentifier),
    executionWorkspaceId: readString(value.executionWorkspaceId),
    runId: readString(value.runId),
    branchName: readString(value.branchName),
    baseRef: readString(value.baseRef),
    relatedIssueIds: readStringArray(value.relatedIssueIds),
    workProductIds: readStringArray(value.workProductIds),
    signalKinds: readStringArray(value.signalKinds),
    status: "pending",
    createdAt,
  };
}

export function readGitHandoffRefs(metadata: Record<string, unknown> | null | undefined): GitHandoffRefMetadata[] {
  const raw = metadata?.[GIT_HANDOFF_REFS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];

  return raw
    .map(normalizeGitHandoffRef)
    .filter((entry): entry is GitHandoffRefMetadata => entry !== null)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function mergeGitHandoffRefMetadata(
  metadata: Record<string, unknown> | null | undefined,
  handoffRef: GitHandoffRefMetadata,
): Record<string, unknown> {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const existing = readGitHandoffRefs(metadata);
  const withoutDuplicate = existing.filter((entry) =>
    entry.ref !== handoffRef.ref &&
    !(entry.sha === handoffRef.sha && entry.runId === handoffRef.runId && entry.issueId === handoffRef.issueId)
  );
  nextMetadata[GIT_HANDOFF_REFS_METADATA_KEY] = [handoffRef, ...withoutDuplicate].slice(0, 50);
  return nextMetadata;
}

export function buildGitHandoffRefName(input: {
  issueId: string | null | undefined;
  runId: string | null | undefined;
  sha: string;
}): string {
  const issuePart = sanitizeGitRefComponent(input.issueId, "unknown-issue");
  const runPart = sanitizeGitRefComponent(input.runId, "unknown-run");
  const shaPart = sanitizeGitRefComponent(input.sha.toLowerCase(), "unknown-sha");
  return `${GIT_HANDOFF_REF_PREFIX}/${issuePart}/${runPart}/${shaPart}`;
}

