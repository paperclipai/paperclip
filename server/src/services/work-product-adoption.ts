import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import type { RuntimeServiceRef } from "./workspace-runtime.js";

const MAX_ADOPTED_WORK_PRODUCTS_PER_RUN = 50;

const WORK_PRODUCT_TYPES = new Set([
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
]);

const WORK_PRODUCT_STATUSES = new Set([
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
  "draft",
]);

const REVIEW_STATES = new Set([
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
]);

type AdoptedWorkProductCandidate = {
  type: string;
  provider: string;
  externalId: string;
  title: string;
  url?: string | null;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  projectId?: string | null;
  executionWorkspaceId?: string | null;
  runtimeServiceId?: string | null;
};

export type WorkProductAdoptionResult = {
  created: number;
  updated: number;
  skipped: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeUrl(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  const normalized = readNonEmptyString(value)?.toLowerCase();
  return normalized && allowed.has(normalized) ? normalized : fallback;
}

function providerForUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (host === "vercel.app" || host.endsWith(".vercel.app")) return "vercel";
  } catch {
    // normalizeUrl already validated this; keep the fallback defensive.
  }
  return "custom";
}

function githubPullRequestIdentity(url: string): { externalId: string; title: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const [owner, repo, kind, number] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo || kind !== "pull" || !number) return null;
    return {
      externalId: `${owner}/${repo}#${number}`,
      title: `${owner}/${repo} PR #${number}`,
    };
  } catch {
    return null;
  }
}

function shortSha(value: string) {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function candidateKey(candidate: AdoptedWorkProductCandidate) {
  return `${candidate.type}\0${candidate.provider}\0${candidate.externalId}`;
}

function uniqueCandidates(candidates: AdoptedWorkProductCandidate[]) {
  const seen = new Set<string>();
  const unique: AdoptedWorkProductCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= MAX_ADOPTED_WORK_PRODUCTS_PER_RUN) break;
  }
  return unique;
}

function isCandidate(value: AdoptedWorkProductCandidate | null): value is AdoptedWorkProductCandidate {
  return value !== null;
}

function valuesFromKeys(record: Record<string, unknown>, keys: string[]): unknown[] {
  const values: unknown[] = [];
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  return values;
}

function urlFromValue(value: unknown): string | null {
  const direct = normalizeUrl(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return normalizeUrl(record.url) ??
    normalizeUrl(record.href) ??
    normalizeUrl(record.htmlUrl) ??
    normalizeUrl(record.html_url) ??
    normalizeUrl(record.openPath) ??
    normalizeUrl(record.open_path);
}

function titleFromValue(value: unknown, fallback: string): string {
  const record = asRecord(value);
  return readNonEmptyString(record?.title) ??
    readNonEmptyString(record?.name) ??
    readNonEmptyString(record?.label) ??
    fallback;
}

function previewCandidateFromValue(value: unknown, index: number): AdoptedWorkProductCandidate | null {
  const url = urlFromValue(value);
  if (!url) return null;
  const record = asRecord(value);
  return {
    type: "preview_url",
    provider: readNonEmptyString(record?.provider) ?? providerForUrl(url),
    externalId: readNonEmptyString(record?.externalId) ?? readNonEmptyString(record?.external_id) ?? url,
    title: titleFromValue(value, index === 0 ? "Preview" : `Preview ${index + 1}`),
    url,
    status: normalizeEnum(record?.status, WORK_PRODUCT_STATUSES, "active"),
    reviewState: normalizeEnum(record?.reviewState ?? record?.review_state, REVIEW_STATES, "none"),
    isPrimary: readBoolean(record?.isPrimary ?? record?.is_primary) ?? index === 0,
    healthStatus: normalizeEnum(record?.healthStatus ?? record?.health_status, new Set(["unknown", "healthy", "unhealthy"]), "unknown") as "unknown" | "healthy" | "unhealthy",
    summary: readNonEmptyString(record?.summary),
    metadata: { adoptedFrom: "result_json" },
  };
}

function pullRequestCandidateFromValue(value: unknown): AdoptedWorkProductCandidate | null {
  const url = urlFromValue(value);
  if (!url) return null;
  const record = asRecord(value);
  const github = githubPullRequestIdentity(url);
  const draft = readBoolean(record?.draft) ?? false;
  const merged = readBoolean(record?.merged) ?? false;
  const closed = readBoolean(record?.closed) ?? false;
  return {
    type: "pull_request",
    provider: readNonEmptyString(record?.provider) ?? providerForUrl(url),
    externalId: readNonEmptyString(record?.externalId) ?? readNonEmptyString(record?.external_id) ?? github?.externalId ?? url,
    title: titleFromValue(value, github?.title ?? "Pull request"),
    url,
    status: normalizeEnum(record?.status, WORK_PRODUCT_STATUSES, merged ? "merged" : closed ? "closed" : draft ? "draft" : "ready_for_review"),
    reviewState: normalizeEnum(record?.reviewState ?? record?.review_state, REVIEW_STATES, "needs_board_review"),
    isPrimary: readBoolean(record?.isPrimary ?? record?.is_primary) ?? true,
    healthStatus: "unknown",
    summary: readNonEmptyString(record?.summary),
    metadata: { adoptedFrom: "result_json" },
  };
}

function branchCandidateFromValue(value: unknown, fallbackExternalScope: string | null): AdoptedWorkProductCandidate | null {
  const record = asRecord(value);
  const branchName = readNonEmptyString(record?.branchName) ??
    readNonEmptyString(record?.branch_name) ??
    readNonEmptyString(record?.name) ??
    readNonEmptyString(value);
  if (!branchName) return null;
  const scope = readNonEmptyString(record?.repoUrl) ??
    readNonEmptyString(record?.repo_url) ??
    readNonEmptyString(record?.repository) ??
    fallbackExternalScope ??
    "workspace";
  return {
    type: "branch",
    provider: readNonEmptyString(record?.provider) ?? "git",
    externalId: `${scope}#${branchName}`,
    title: titleFromValue(value, `Branch ${branchName}`),
    status: normalizeEnum(record?.status, WORK_PRODUCT_STATUSES, "active"),
    reviewState: normalizeEnum(record?.reviewState ?? record?.review_state, REVIEW_STATES, "none"),
    isPrimary: readBoolean(record?.isPrimary ?? record?.is_primary) ?? false,
    healthStatus: "unknown",
    summary: readNonEmptyString(record?.summary),
    metadata: { adoptedFrom: "result_json", branchName },
  };
}

function commitCandidateFromValue(value: unknown): AdoptedWorkProductCandidate | null {
  const record = asRecord(value);
  const url = urlFromValue(value);
  const sha = readNonEmptyString(record?.sha) ??
    readNonEmptyString(record?.commitSha) ??
    readNonEmptyString(record?.commit_sha) ??
    (/^[0-9a-f]{7,40}$/i.test(readNonEmptyString(value) ?? "") ? readNonEmptyString(value) : null);
  if (!sha && !url) return null;
  const externalId = readNonEmptyString(record?.externalId) ??
    readNonEmptyString(record?.external_id) ??
    sha ??
    url!;
  return {
    type: "commit",
    provider: readNonEmptyString(record?.provider) ?? (url ? providerForUrl(url) : "git"),
    externalId,
    title: titleFromValue(value, sha ? `Commit ${shortSha(sha)}` : "Commit"),
    url,
    status: normalizeEnum(record?.status, WORK_PRODUCT_STATUSES, "active"),
    reviewState: normalizeEnum(record?.reviewState ?? record?.review_state, REVIEW_STATES, "none"),
    isPrimary: readBoolean(record?.isPrimary ?? record?.is_primary) ?? false,
    healthStatus: "unknown",
    summary: readNonEmptyString(record?.summary) ?? readNonEmptyString(record?.message),
    metadata: { adoptedFrom: "result_json", ...(sha ? { sha } : {}) },
  };
}

function artifactCandidateFromValue(value: unknown): AdoptedWorkProductCandidate | null {
  const explicit = explicitCandidateFromValue(value);
  if (explicit) return explicit;
  const url = urlFromValue(value);
  if (!url) return null;
  const record = asRecord(value);
  return {
    type: "artifact",
    provider: readNonEmptyString(record?.provider) ?? providerForUrl(url),
    externalId: readNonEmptyString(record?.externalId) ?? readNonEmptyString(record?.external_id) ?? url,
    title: titleFromValue(value, "Artifact"),
    url,
    status: normalizeEnum(record?.status, WORK_PRODUCT_STATUSES, "ready_for_review"),
    reviewState: normalizeEnum(record?.reviewState ?? record?.review_state, REVIEW_STATES, "needs_board_review"),
    isPrimary: readBoolean(record?.isPrimary ?? record?.is_primary) ?? false,
    healthStatus: normalizeEnum(record?.healthStatus ?? record?.health_status, new Set(["unknown", "healthy", "unhealthy"]), "unknown") as "unknown" | "healthy" | "unhealthy",
    summary: readNonEmptyString(record?.summary),
    metadata: { adoptedFrom: "result_json" },
  };
}

function explicitCandidateFromValue(value: unknown): AdoptedWorkProductCandidate | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = normalizeEnum(record.type, WORK_PRODUCT_TYPES, "");
  if (!type) return null;
  const url = normalizeUrl(record.url);
  const externalId = readNonEmptyString(record.externalId) ?? readNonEmptyString(record.external_id) ?? url;
  if (!externalId) return null;
  return {
    type,
    provider: readNonEmptyString(record.provider) ?? (url ? providerForUrl(url) : "custom"),
    externalId,
    title: titleFromValue(value, type.replace(/_/g, " ")),
    url,
    status: normalizeEnum(record.status, WORK_PRODUCT_STATUSES, type === "pull_request" ? "ready_for_review" : "active"),
    reviewState: normalizeEnum(record.reviewState ?? record.review_state, REVIEW_STATES, type === "pull_request" ? "needs_board_review" : "none"),
    isPrimary: readBoolean(record.isPrimary ?? record.is_primary) ?? false,
    healthStatus: normalizeEnum(record.healthStatus ?? record.health_status, new Set(["unknown", "healthy", "unhealthy"]), "unknown") as "unknown" | "healthy" | "unhealthy",
    summary: readNonEmptyString(record.summary),
    metadata: asRecord(record.metadata) ?? { adoptedFrom: "result_json" },
  };
}

function runtimeServiceStatus(service: RuntimeServiceRef) {
  if (service.status === "failed") return "failed";
  if (service.status === "stopped") return "closed";
  return "active";
}

function runtimeServiceCandidate(service: RuntimeServiceRef): AdoptedWorkProductCandidate {
  const title = service.url && service.serviceName.toLowerCase().includes("preview")
    ? `Preview: ${service.serviceName}`
    : `Runtime service: ${service.serviceName}`;
  return {
    type: "runtime_service",
    provider: "paperclip",
    externalId: service.id,
    title,
    url: service.url,
    status: runtimeServiceStatus(service),
    reviewState: "none",
    isPrimary: Boolean(service.url),
    healthStatus: service.healthStatus,
    summary: service.url
      ? `${service.serviceName} is available at ${service.url}.`
      : `${service.serviceName} runtime service is ${service.status}.`,
    metadata: {
      adoptedFrom: "runtime_service",
      serviceName: service.serviceName,
      serviceProvider: service.provider,
      scopeType: service.scopeType,
      scopeId: service.scopeId,
      reused: service.reused,
      port: service.port,
    },
    projectId: service.projectId,
    executionWorkspaceId: service.executionWorkspaceId,
    runtimeServiceId: service.id,
  };
}

function collectResultJsonCandidates(input: {
  resultJson: Record<string, unknown> | null | undefined;
  workspaceExternalScope: string | null;
}): AdoptedWorkProductCandidate[] {
  const roots = [input.resultJson, asRecord(input.resultJson?.meta), asRecord(asRecord(input.resultJson?.result)?.meta)]
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const candidates: AdoptedWorkProductCandidate[] = [];

  for (const root of roots) {
    candidates.push(
      ...valuesFromKeys(root, ["workProducts", "work_products"]).map(explicitCandidateFromValue).filter(isCandidate),
      ...valuesFromKeys(root, ["previewUrl", "preview_url", "previewUrls", "preview_urls", "previews"])
        .map((value, index) => previewCandidateFromValue(value, index))
        .filter(isCandidate),
      ...valuesFromKeys(root, ["pullRequest", "pull_request", "pullRequests", "pull_requests", "pullRequestUrl", "pull_request_url", "prUrl", "pr_url"])
        .map(pullRequestCandidateFromValue)
        .filter(isCandidate),
      ...valuesFromKeys(root, ["branch", "branchName", "branch_name", "branches"])
        .map((value) => branchCandidateFromValue(value, input.workspaceExternalScope))
        .filter(isCandidate),
      ...valuesFromKeys(root, ["commit", "commits", "commitSha", "commit_sha", "commitUrl", "commit_url", "commitUrls", "commit_urls"])
        .map(commitCandidateFromValue)
        .filter(isCandidate),
      ...valuesFromKeys(root, ["artifact", "artifacts"])
        .map(artifactCandidateFromValue)
        .filter(isCandidate),
    );
  }

  return candidates;
}

export async function adoptWorkProductsForRun(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  projectId?: string | null;
  executionWorkspaceId?: string | null;
  workspace?: {
    cwd?: string | null;
    repoUrl?: string | null;
    repoRef?: string | null;
    branchName?: string | null;
  } | null;
  runtimeServices?: RuntimeServiceRef[];
  resultJson?: Record<string, unknown> | null;
  sourceTrust?: SourceTrustMetadata | null;
}): Promise<WorkProductAdoptionResult> {
  const workspaceExternalScope =
    readNonEmptyString(input.workspace?.repoUrl) ??
    readNonEmptyString(input.workspace?.cwd) ??
    null;
  const candidates = uniqueCandidates([
    ...(input.runtimeServices ?? []).map(runtimeServiceCandidate),
    ...(input.workspace?.branchName ? [branchCandidateFromValue({
      branchName: input.workspace.branchName,
      repoUrl: input.workspace.repoUrl,
      status: "active",
    }, workspaceExternalScope)].filter(isCandidate) : []),
    ...collectResultJsonCandidates({
      resultJson: input.resultJson,
      workspaceExternalScope,
    }),
  ]);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    if (!WORK_PRODUCT_TYPES.has(candidate.type) || !candidate.provider || !candidate.externalId) {
      skipped += 1;
      continue;
    }

    const now = new Date();
    const values = {
      companyId: input.companyId,
      issueId: input.issueId,
      projectId: candidate.projectId ?? input.projectId ?? null,
      executionWorkspaceId: candidate.executionWorkspaceId ?? input.executionWorkspaceId ?? null,
      runtimeServiceId: candidate.runtimeServiceId ?? null,
      type: candidate.type,
      provider: candidate.provider,
      externalId: candidate.externalId,
      title: candidate.title,
      url: candidate.url ?? null,
      status: candidate.status,
      reviewState: candidate.reviewState,
      isPrimary: candidate.isPrimary,
      healthStatus: candidate.healthStatus,
      summary: candidate.summary ?? null,
      metadata: candidate.metadata ?? null,
      sourceTrust: input.sourceTrust ?? null,
      updatedAt: now,
    };

    const outcome = await input.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, input.companyId),
          eq(issueWorkProducts.issueId, input.issueId),
          eq(issueWorkProducts.type, candidate.type),
          eq(issueWorkProducts.provider, candidate.provider),
          eq(issueWorkProducts.externalId, candidate.externalId),
        ))
        .orderBy(desc(issueWorkProducts.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (candidate.isPrimary) {
        await tx
          .update(issueWorkProducts)
          .set({ isPrimary: false, updatedAt: now })
          .where(and(
            eq(issueWorkProducts.companyId, input.companyId),
            eq(issueWorkProducts.issueId, input.issueId),
            eq(issueWorkProducts.type, candidate.type),
          ));
      }

      await tx
        .insert(issueWorkProducts)
        .values({
          ...values,
          createdByRunId: input.runId,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [
            issueWorkProducts.companyId,
            issueWorkProducts.issueId,
            issueWorkProducts.type,
            issueWorkProducts.provider,
            issueWorkProducts.externalId,
          ],
          set: values,
        });

      return existing ? "updated" as const : "created" as const;
    });

    if (outcome === "created") created += 1;
    else updated += 1;
  }

  return { created, updated, skipped };
}
