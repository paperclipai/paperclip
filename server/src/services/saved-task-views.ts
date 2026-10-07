import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userSavedTaskViews } from "@paperclipai/db";
import type { SavedTaskView } from "@paperclipai/shared";

export type SavedTaskViewOwner = {
  companyId: string;
  userId: string;
};

type SavedTaskViewRow = typeof userSavedTaskViews.$inferSelect;

export class SavedTaskViewNameTakenError extends Error {
  constructor(name: string) {
    super(`A view named "${name}" already exists in this collection`);
    this.name = "SavedTaskViewNameTakenError";
  }
}

function toSavedTaskView(row: SavedTaskViewRow): SavedTaskView {
  return {
    id: row.id,
    companyId: row.companyId,
    collectionKey: row.collectionKey,
    name: row.name,
    viewState: (row.viewState ?? {}) as Record<string, unknown>,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type PostgresError = {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  cause?: unknown;
};

// Postgres reports the unique-name clash as 23505, but Drizzle wraps the driver
// error, so the 23505 is on `cause` rather than on the error it throws. Walk the
// chain instead of reading only the top. Driver versions also differ on whether
// the constraint name comes back, so an unnamed 23505 on these two statements is
// treated as the name clash it can only be.
function isUniqueNameViolation(error: unknown): boolean {
  for (let depth = 0, candidate = error as PostgresError | null; candidate && depth < 5; depth += 1) {
    if (candidate.code === "23505") {
      const constraint = candidate.constraint_name ?? candidate.constraint ?? "";
      return constraint === "" || constraint.includes("user_saved_task_views_owner_name_uq");
    }
    candidate = (candidate.cause ?? null) as PostgresError | null;
  }
  return false;
}

export function savedTaskViewService(db: Db) {
  // Scoping every read and write by company *and* user is what keeps a saved
  // view private to the person who made it, including on update and delete.
  function ownerScope(owner: SavedTaskViewOwner) {
    return [
      eq(userSavedTaskViews.companyId, owner.companyId),
      eq(userSavedTaskViews.userId, owner.userId),
    ];
  }

  async function nextPosition(owner: SavedTaskViewOwner, collectionKey: string): Promise<number> {
    const [row] = await db
      .select({ maxPosition: sql<number | null>`max(${userSavedTaskViews.position})` })
      .from(userSavedTaskViews)
      .where(and(...ownerScope(owner), eq(userSavedTaskViews.collectionKey, collectionKey)));
    return (row?.maxPosition ?? -1) + 1;
  }

  return {
    async list(owner: SavedTaskViewOwner, collectionKey?: string): Promise<SavedTaskView[]> {
      const scope = ownerScope(owner);
      if (collectionKey) scope.push(eq(userSavedTaskViews.collectionKey, collectionKey));

      const rows = await db
        .select()
        .from(userSavedTaskViews)
        .where(and(...scope))
        .orderBy(asc(userSavedTaskViews.position), asc(userSavedTaskViews.createdAt));
      return rows.map(toSavedTaskView);
    },

    async create(
      owner: SavedTaskViewOwner,
      input: {
        collectionKey: string;
        name: string;
        viewState: Record<string, unknown>;
        position?: number;
      },
    ): Promise<SavedTaskView> {
      // New views land at the end of the owner's list for this collection
      // unless the caller places them explicitly.
      const position = input.position ?? await nextPosition(owner, input.collectionKey);
      try {
        const [row] = await db
          .insert(userSavedTaskViews)
          .values({
            companyId: owner.companyId,
            userId: owner.userId,
            collectionKey: input.collectionKey,
            name: input.name,
            viewState: input.viewState,
            position,
          })
          .returning();
        return toSavedTaskView(row!);
      } catch (error) {
        if (isUniqueNameViolation(error)) throw new SavedTaskViewNameTakenError(input.name);
        throw error;
      }
    },

    async update(
      owner: SavedTaskViewOwner,
      savedTaskViewId: string,
      patch: { name?: string; viewState?: Record<string, unknown>; position?: number },
    ): Promise<SavedTaskView | null> {
      try {
        const [row] = await db
          .update(userSavedTaskViews)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.viewState === undefined ? {} : { viewState: patch.viewState }),
            ...(patch.position === undefined ? {} : { position: patch.position }),
            updatedAt: new Date(),
          })
          .where(and(eq(userSavedTaskViews.id, savedTaskViewId), ...ownerScope(owner)))
          .returning();
        return row ? toSavedTaskView(row) : null;
      } catch (error) {
        if (patch.name !== undefined && isUniqueNameViolation(error)) {
          throw new SavedTaskViewNameTakenError(patch.name);
        }
        throw error;
      }
    },

    // Returns the view that was deleted, so the caller can say *what* was
    // removed in the activity entry. `null` means there was nothing to delete
    // under this owner.
    async remove(
      owner: SavedTaskViewOwner,
      savedTaskViewId: string,
    ): Promise<SavedTaskView | null> {
      const [row] = await db
        .delete(userSavedTaskViews)
        .where(and(eq(userSavedTaskViews.id, savedTaskViewId), ...ownerScope(owner)))
        .returning();
      return row ? toSavedTaskView(row) : null;
    },
  };
}
