import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueWorkProducts, issues } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import {
  COMPLETION_REQUIREMENT_KINDS,
  WORK_PRODUCT_TYPES,
  type CompletionRequirement,
  type ExpectedWorkProduct,
  type WorkProductType,
  decideCompletionGate,
} from "./completion-gate.js";
import { createVerifierDeps, verifyWorkProduct } from "./verifier.js";

export type CompletionGateMode = "off" | "warn" | "enforce";

/**
 * Rollout switch. Defaults to `warn`: the gate evaluates and logs what it *would* block, so the
 * false-positive rate can be measured before it starts refusing real completions.
 */
export function readCompletionGateMode(env = process.env): CompletionGateMode {
  const raw = env.PAPERCLIP_COMPLETION_GATE?.trim().toLowerCase();
  if (raw === "off" || raw === "enforce" || raw === "warn") return raw;
  return "warn";
}

/** Absolute roots a declared file may live under (colon-separated), e.g. the repo and the vault. */
export function readWorkProductRoots(env = process.env): string[] {
  const raw = env.PAPERCLIP_WORK_PRODUCT_ROOTS?.trim();
  const roots = raw ? raw.split(":").map((entry) => entry.trim()).filter(Boolean) : [process.cwd()];
  return roots;
}

export function parseCompletionRequirement(value: unknown): CompletionRequirement {
  return COMPLETION_REQUIREMENT_KINDS.includes(value as CompletionRequirement)
    ? (value as CompletionRequirement)
    : "none";
}

export function parseExpectedWorkProduct(value: unknown): ExpectedWorkProduct | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (!WORK_PRODUCT_TYPES.includes(type as WorkProductType)) return null;
  const location = typeof record.location === "string" && record.location.trim()
    ? record.location.trim()
    : null;
  return { type: type as WorkProductType, location };
}

function buildDeps(db: Db, companyId: string) {
  return createVerifierDeps({
    roots: readWorkProductRoots(),
    documentHasBody: async (documentId) => {
      const [row] = await db
        .select({ body: documents.latestBody })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)))
        .limit(1);
      return Boolean(row?.body?.trim());
    },
  });
}

/**
 * Verifies a single declared work product. Used when an agent declares one, so the stored
 * health status is always the server's own finding, never the agent's claim.
 */
export async function verifyDeclaredWorkProduct(input: {
  db: Db;
  companyId: string;
  product: { type: string; provider: string; externalId?: string | null; url?: string | null; metadata?: Record<string, unknown> | null };
}) {
  return verifyWorkProduct(
    {
      type: input.product.type,
      provider: input.product.provider,
      externalId: input.product.externalId ?? null,
      url: input.product.url ?? null,
      metadata: input.product.metadata ?? null,
    },
    buildDeps(input.db, input.companyId),
  );
}

/**
 * Re-verifies the issue's declared work products and decides whether `done` may proceed.
 *
 * Verification is never cached across the transition: an artifact that existed when it was
 * declared may have been moved or deleted since, and the whole point of the gate is that we
 * look rather than trust.
 */
export async function assertCompletionAllowed(input: {
  db: Db;
  issue: typeof issues.$inferSelect;
  /** Humans are never gated — a person may always close an issue. */
  actorUserId?: string | null;
  mode?: CompletionGateMode;
}): Promise<void> {
  const mode = input.mode ?? readCompletionGateMode();
  if (mode === "off") return;
  if (input.actorUserId) return;

  const requirement = parseCompletionRequirement(input.issue.completionRequirement);
  if (requirement === "none") return;

  const expected = parseExpectedWorkProduct(input.issue.expectedWorkProduct);

  const rows = await input.db
    .select()
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.issue.id));

  const deps = buildDeps(input.db, input.issue.companyId);

  const declared = [];
  for (const row of rows) {
    const health = await verifyWorkProduct(
      {
        type: row.type,
        provider: row.provider,
        externalId: row.externalId,
        url: row.url,
        metadata: row.metadata ?? null,
      },
      deps,
    );
    if (health !== row.healthStatus) {
      await input.db
        .update(issueWorkProducts)
        .set({ healthStatus: health, updatedAt: new Date() })
        .where(eq(issueWorkProducts.id, row.id));
    }
    declared.push({
      type: row.type,
      provider: row.provider,
      externalId: row.externalId,
      url: row.url,
      isPrimary: row.isPrimary,
      healthStatus: health,
    });
  }

  const decision = decideCompletionGate({ requirement, expected, declared });
  if (decision.allowed) return;

  if (mode === "warn") {
    logger.warn(
      {
        issueId: input.issue.id,
        identifier: input.issue.identifier,
        reason: decision.reason,
        expected,
        declared,
      },
      `completion-gate(warn): would block done — ${decision.message}`,
    );
    return;
  }

  throw unprocessable(decision.message ?? "This issue cannot be marked done yet.");
}
