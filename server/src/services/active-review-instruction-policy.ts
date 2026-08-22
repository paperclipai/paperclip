import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { conflict, HttpError } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const ACTIVE_REVIEW_INSTRUCTION_MUTATION_DENIED = "active_review_instruction_mutation_denied";
export const REVIEW_RUNTIME_POLICY_SETTINGS_KEY = "reviewRuntimePolicy";

const ACTIVE_REVIEW_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

export type ReviewRuntimePolicyFlags = {
  requireTrustedSourceTrust: boolean;
  repositoryAccessRequired: boolean;
};

export type PinnedReviewRuntimePolicy = ReviewRuntimePolicyFlags & {
  contentHash: string;
  snapshotRootPath?: string;
  entryFile: string;
  agentId?: string;
  issueId?: string;
  pinnedAt?: string;
};

export type ActiveReviewIssueLike = {
  status?: string | null;
  title?: string | null;
  originKind?: string | null;
  hiddenAt?: Date | string | null;
  executionState?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function issueTitleIndicatesReview(title: string | null | undefined): boolean {
  const normalized = (title ?? "").trim();
  if (!normalized) return false;
  if (/\bindependent\s+review\b/i.test(normalized)) return true;
  if (/\breview of\b/i.test(normalized)) return true;
  if (/^review\b/i.test(normalized)) return true;
  if (/\bwatchdog review\b/i.test(normalized)) return true;
  return false;
}

export function isActiveReviewIssue(issue: ActiveReviewIssueLike): boolean {
  if (issue.hiddenAt) return false;
  const status = (issue.status ?? "").trim();
  if (!status || TERMINAL_STATUSES.has(status)) return false;
  if (!ACTIVE_REVIEW_STATUSES.includes(status as (typeof ACTIVE_REVIEW_STATUSES)[number])) return false;

  if ((issue.originKind ?? "").trim() === "task_watchdog") return true;

  const executionState = asRecord(issue.executionState);
  if (readNonEmptyString(executionState.currentStageType) === "review") return true;

  return issueTitleIndicatesReview(issue.title);
}

export function deriveReviewRuntimePolicy(instructions: string): ReviewRuntimePolicyFlags {
  const requireTrustedSourceTrust = /sourceTrust/i.test(instructions) && /\btrusted\b/i.test(instructions);
  const repositoryAccessRequired =
    /repositoryAccessRequired\s*:\s*true/.test(instructions)
    || /repositoryAccessRequired[^.\n]{0,80}true/i.test(instructions)
    || (/repositoryAccessRequired/i.test(instructions) && /other than true/i.test(instructions));
  return { requireTrustedSourceTrust, repositoryAccessRequired };
}

export function reviewRuntimePolicyWouldWeaken(
  current: ReviewRuntimePolicyFlags,
  next: ReviewRuntimePolicyFlags,
): boolean {
  return (current.requireTrustedSourceTrust && !next.requireTrustedSourceTrust)
    || (current.repositoryAccessRequired && !next.repositoryAccessRequired);
}

export function hashManagedInstructionContents(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(files[relativePath] ?? "");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function applyPinnedReviewRuntimePolicyToAdapterConfig(
  adapterConfig: Record<string, unknown>,
  policy: Pick<PinnedReviewRuntimePolicy, "snapshotRootPath" | "entryFile">,
): Record<string, unknown> {
  const snapshotRootPath = readNonEmptyString(policy.snapshotRootPath);
  const entryFile = readNonEmptyString(policy.entryFile) ?? "AGENTS.md";
  if (!snapshotRootPath) return { ...adapterConfig };
  return {
    ...adapterConfig,
    instructionsBundleMode: "managed",
    instructionsRootPath: snapshotRootPath,
    instructionsEntryFile: entryFile,
    instructionsFilePath: path.join(snapshotRootPath, entryFile),
  };
}

export function isActiveReviewInstructionMutationDenied(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  const details = asRecord(err.details);
  return details.code === ACTIVE_REVIEW_INSTRUCTION_MUTATION_DENIED;
}

export function reviewRuntimePolicySnapshotRoot(input: {
  companyId: string;
  agentId: string;
  issueId: string;
}): string {
  return path.join(
    resolvePaperclipInstanceRoot(),
    "companies",
    input.companyId,
    "agents",
    input.agentId,
    "review-policy-pins",
    input.issueId,
  );
}

export async function writeReviewRuntimePolicySnapshot(input: {
  companyId: string;
  agentId: string;
  issueId: string;
  files: Record<string, string>;
}): Promise<string> {
  const snapshotRootPath = reviewRuntimePolicySnapshotRoot(input);
  await fs.mkdir(snapshotRootPath, { recursive: true });
  for (const [relativePath, content] of Object.entries(input.files)) {
    const absolutePath = path.join(snapshotRootPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  return snapshotRootPath;
}

export function readPinnedReviewRuntimePolicy(
  executionWorkspaceSettings: unknown,
): PinnedReviewRuntimePolicy | null {
  const pinned = asRecord(asRecord(executionWorkspaceSettings)[REVIEW_RUNTIME_POLICY_SETTINGS_KEY]);
  const contentHash = readNonEmptyString(pinned.contentHash);
  if (!contentHash) return null;
  return {
    contentHash,
    requireTrustedSourceTrust: pinned.requireTrustedSourceTrust === true,
    repositoryAccessRequired: pinned.repositoryAccessRequired === true,
    snapshotRootPath: readNonEmptyString(pinned.snapshotRootPath) ?? undefined,
    entryFile: readNonEmptyString(pinned.entryFile) ?? "AGENTS.md",
    agentId: readNonEmptyString(pinned.agentId) ?? undefined,
    issueId: readNonEmptyString(pinned.issueId) ?? undefined,
    pinnedAt: readNonEmptyString(pinned.pinnedAt) ?? undefined,
  };
}

function mergeExecutionWorkspaceSettings(
  current: unknown,
  policy: PinnedReviewRuntimePolicy,
): Record<string, unknown> {
  return {
    ...asRecord(current),
    [REVIEW_RUNTIME_POLICY_SETTINGS_KEY]: {
      contentHash: policy.contentHash,
      requireTrustedSourceTrust: policy.requireTrustedSourceTrust,
      repositoryAccessRequired: policy.repositoryAccessRequired,
      snapshotRootPath: policy.snapshotRootPath ?? null,
      entryFile: policy.entryFile,
      agentId: policy.agentId ?? null,
      issueId: policy.issueId ?? null,
      pinnedAt: policy.pinnedAt ?? null,
    },
  };
}

export function activeReviewInstructionPolicyService(db: Db) {
  return {
    listActiveReviewsForAgent: async (input: {
      companyId: string;
      targetAgentId: string;
    }) => {
      const rows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          originKind: issues.originKind,
          executionState: issues.executionState,
          hiddenAt: issues.hiddenAt,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, input.companyId),
          eq(issues.assigneeAgentId, input.targetAgentId),
          inArray(issues.status, [...ACTIVE_REVIEW_STATUSES]),
          isNull(issues.hiddenAt),
        ));
      return rows.filter((row) => isActiveReviewIssue(row));
    },

    assertManagedInstructionMutationAllowed: async (input: {
      companyId: string;
      targetAgentId: string;
    }) => {
      const activeReviews = await activeReviewInstructionPolicyService(db).listActiveReviewsForAgent(input);
      if (activeReviews.length === 0) return;
      throw conflict(
        "Managed agent instructions cannot change while the agent has an active Review",
        {
          code: ACTIVE_REVIEW_INSTRUCTION_MUTATION_DENIED,
          activeReviewIssueIds: activeReviews.map((row) => row.id),
          activeReviewIdentifiers: activeReviews
            .map((row) => row.identifier)
            .filter((identifier): identifier is string => Boolean(identifier)),
        },
      );
    },

    pinReviewRuntimePolicy: async (input: {
      companyId: string;
      issueId: string;
      agentId: string;
      files: Record<string, string>;
      snapshotRootPath?: string | null;
      entryFile?: string | null;
    }): Promise<PinnedReviewRuntimePolicy> => {
      const [issue] = await db
        .select({
          id: issues.id,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .limit(1);
      if (!issue) {
        throw conflict("Cannot pin review runtime policy on a missing issue");
      }

      const existing = readPinnedReviewRuntimePolicy(issue.executionWorkspaceSettings);
      if (existing) return existing;

      const joinedInstructions = Object.keys(input.files)
        .sort()
        .map((relativePath) => input.files[relativePath] ?? "")
        .join("\n");
      const derived = deriveReviewRuntimePolicy(joinedInstructions);
      const pinned: PinnedReviewRuntimePolicy = {
        contentHash: hashManagedInstructionContents(input.files),
        requireTrustedSourceTrust: derived.requireTrustedSourceTrust,
        repositoryAccessRequired: derived.repositoryAccessRequired,
        snapshotRootPath: readNonEmptyString(input.snapshotRootPath) ?? undefined,
        entryFile: readNonEmptyString(input.entryFile) ?? "AGENTS.md",
        agentId: input.agentId,
        issueId: input.issueId,
        pinnedAt: new Date().toISOString(),
      };

      await db
        .update(issues)
        .set({
          executionWorkspaceSettings: mergeExecutionWorkspaceSettings(
            issue.executionWorkspaceSettings,
            pinned,
          ),
          updatedAt: new Date(),
        })
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));

      return pinned;
    },
  };
}
