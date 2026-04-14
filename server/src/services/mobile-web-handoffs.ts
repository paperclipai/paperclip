import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mobileWebHandoffs } from "@paperclipai/db";

export const MOBILE_WEB_HANDOFF_TTL_MS = 10 * 60 * 1000;

export type MobileWebHandoffConsumeResult =
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "used" }
  | { status: "ok"; handoff: typeof mobileWebHandoffs.$inferSelect };

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_mwh_${randomBytes(24).toString("hex")}`;
}

export function mobileWebHandoffService(db: Db) {
  async function create(input: {
    userId: string;
    targetPath: string;
    companyId?: string | null;
  }) {
    const token = createToken();
    const expiresAt = new Date(Date.now() + MOBILE_WEB_HANDOFF_TTL_MS);
    await db.insert(mobileWebHandoffs).values({
      id: randomUUID(),
      tokenHash: hashToken(token),
      userId: input.userId,
      targetPath: input.targetPath,
      companyId: input.companyId ?? null,
      expiresAt,
      createdAt: new Date(),
    });

    return { token, expiresAt };
  }

  async function consume(token: string): Promise<MobileWebHandoffConsumeResult> {
    const tokenHash = hashToken(token);
    const handoff = await db
      .select()
      .from(mobileWebHandoffs)
      .where(eq(mobileWebHandoffs.tokenHash, tokenHash))
      .then((rows) => rows[0] ?? null);

    if (!handoff) {
      return { status: "invalid" };
    }
    if (handoff.usedAt) {
      return { status: "used" };
    }
    if (handoff.expiresAt.getTime() <= Date.now()) {
      return { status: "expired" };
    }

    const usedAt = new Date();
    const consumed = await db
      .update(mobileWebHandoffs)
      .set({ usedAt })
      .where(
        and(
          eq(mobileWebHandoffs.id, handoff.id),
          isNull(mobileWebHandoffs.usedAt),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!consumed) {
      return { status: "used" };
    }

    return { status: "ok", handoff: consumed };
  }

  return {
    create,
    consume,
  };
}
