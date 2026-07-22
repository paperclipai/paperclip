import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { statusCards, statusCardUpdates, type Db } from "@paperclipai/db";
import type { CreateStatusCard, PatchStatusCard } from "@paperclipai/shared";

type StatusCardActor = { agentId: string | null; userId: string | null };

export function statusCardService(db: Db) {
  async function list(companyId: string, archived: boolean) {
    return db
      .select()
      .from(statusCards)
      .where(and(eq(statusCards.companyId, companyId), archived ? isNotNull(statusCards.archivedAt) : isNull(statusCards.archivedAt)))
      .orderBy(desc(statusCards.updatedAt));
  }

  async function getById(id: string) {
    return db.select().from(statusCards).where(eq(statusCards.id, id)).then((rows) => rows[0] ?? null);
  }

  async function create(companyId: string, input: CreateStatusCard, actor: StatusCardActor) {
    return db
      .insert(statusCards)
      .values({
        companyId,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.userId,
        title: input.title ?? null,
        titlePinned: input.titlePinned,
        interestPrompt: input.interestPrompt,
        instructionsMode: input.instructionsMode,
        instructions: input.instructions ?? null,
        refreshPolicy: input.refreshPolicy,
        state: "compiling",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function update(card: typeof statusCards.$inferSelect, input: PatchStatusCard, actor: StatusCardActor) {
    const now = new Date();
    const archiveChanged = input.archived !== undefined && input.archived !== Boolean(card.archivedAt);
    const values: Partial<typeof statusCards.$inferInsert> = {
      updatedAt: now,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.titlePinned !== undefined ? { titlePinned: input.titlePinned } : {}),
      ...(input.interestPrompt !== undefined
        ? { interestPrompt: input.interestPrompt, state: "compiling", failureReason: null }
        : {}),
      ...(input.instructionsMode !== undefined ? { instructionsMode: input.instructionsMode } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.refreshPolicy !== undefined ? { refreshPolicy: input.refreshPolicy } : {}),
      ...(archiveChanged && input.archived
        ? {
            archivedAt: now,
            archivedByAgentId: actor.agentId,
            archivedByUserId: actor.userId,
            nextEvalAt: null,
          }
        : {}),
      ...(archiveChanged && !input.archived
        ? { archivedAt: null, archivedByAgentId: null, archivedByUserId: null, lastChangeAt: now }
        : {}),
    };
    return db.update(statusCards).set(values).where(eq(statusCards.id, card.id)).returning().then((rows) => rows[0]!);
  }

  async function remove(id: string) {
    return db.delete(statusCards).where(eq(statusCards.id, id)).returning().then((rows) => rows[0] ?? null);
  }

  async function listUpdates(cardId: string) {
    return db.select().from(statusCardUpdates).where(eq(statusCardUpdates.cardId, cardId)).orderBy(desc(statusCardUpdates.startedAt));
  }

  async function requestCompile(_cardId: string) {
    // TODO(P2): enqueue the status-card query compilation task.
  }

  return { list, getById, create, update, remove, listUpdates, requestCompile };
}
