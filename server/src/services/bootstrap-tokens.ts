import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { bootstrapTokens } from "@paperclipai/db";

export interface BootstrapTokenBinding {
  agentId: string;
  companyId: string;
  runId: string;
  jobUid: string;
}

export interface MintInput extends BootstrapTokenBinding {
  ttlSeconds: number;
}

export interface MintResult {
  token: string;
  expiresAt: Date;
}

export type ValidateResult =
  | { ok: true; binding: BootstrapTokenBinding }
  | { ok: false; reason: "not_found" | "expired" | "already_consumed" };

export interface BootstrapTokensService {
  mint(input: MintInput): Promise<MintResult>;
  validateAndConsume(token: string): Promise<ValidateResult>;
  purgeExpired(input?: { olderThanMs?: number; now?: Date }): Promise<number>;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bootstrapTokensService(db: Db): BootstrapTokensService {
  return {
    async mint(input) {
      const raw = randomBytes(32).toString("base64url");
      const token = `bst_${raw}`;
      const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
      await db.insert(bootstrapTokens).values({
        tokenHash: hashToken(token),
        agentId: input.agentId,
        companyId: input.companyId,
        runId: input.runId,
        jobUid: input.jobUid,
        expiresAt,
      });
      return { token, expiresAt };
    },

    async validateAndConsume(token) {
      const hash = hashToken(token);
      // Atomic claim: only one concurrent caller can flip consumed_at from NULL.
      // The unique index on token_hash + the WHERE consumed_at IS NULL clause guarantees
      // RETURNING yields a row exactly once across concurrent callers. Expired tokens
      // are not claimed so consumed_at stays NULL for diagnostics.
      const now = new Date();
      const [claimed] = await db
        .update(bootstrapTokens)
        .set({ consumedAt: now })
        .where(and(
          eq(bootstrapTokens.tokenHash, hash),
          isNull(bootstrapTokens.consumedAt),
          gt(bootstrapTokens.expiresAt, now),
        ))
        .returning();
      if (claimed) {
        return {
          ok: true,
          binding: { agentId: claimed.agentId, companyId: claimed.companyId, runId: claimed.runId, jobUid: claimed.jobUid },
        };
      }
      // Claim failed: distinguish not_found / expired / already_consumed for diagnostics.
      const [row] = await db.select().from(bootstrapTokens).where(eq(bootstrapTokens.tokenHash, hash));
      if (!row) return { ok: false, reason: "not_found" };
      if (row.consumedAt) return { ok: false, reason: "already_consumed" };
      return { ok: false, reason: "expired" };
    },

    async purgeExpired(input = {}) {
      const olderThanMs = input.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
      const now = input.now ?? new Date();
      const cutoff = new Date(now.getTime() - olderThanMs);
      const rows = await db
        .delete(bootstrapTokens)
        .where(lt(bootstrapTokens.expiresAt, cutoff))
        .returning({ id: bootstrapTokens.id });
      return rows.length;
    },
  };
}
