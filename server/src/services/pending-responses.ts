import { eq, and, isNull, or, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pendingResponses } from "@paperclipai/db";

export function pendingResponseService(db: Db) {
  async function create(input: {
    companyId: string;
    waitingAgentId: string;
    channelId: string;
    threadTs: string;
    expiresAt?: Date;
  }) {
    const [row] = await db
      .insert(pendingResponses)
      .values({
        companyId: input.companyId,
        waitingAgentId: input.waitingAgentId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        status: "pending",
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return row!;
  }

  async function listActivePending(now: Date) {
    return db
      .select()
      .from(pendingResponses)
      .where(
        and(
          eq(pendingResponses.status, "pending"),
          or(isNull(pendingResponses.expiresAt), gt(pendingResponses.expiresAt, now)),
        ),
      );
  }

  async function markFulfilled(id: string) {
    await db
      .update(pendingResponses)
      .set({ status: "fulfilled" })
      .where(eq(pendingResponses.id, id));
  }

  async function markExpired(id: string) {
    await db
      .update(pendingResponses)
      .set({ status: "expired" })
      .where(eq(pendingResponses.id, id));
  }

  return { create, listActivePending, markFulfilled, markExpired };
}
