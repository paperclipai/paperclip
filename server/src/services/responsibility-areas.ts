import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { responsibilityAreas } from "@paperclipai/db";
import type {
  CreateResponsibilityArea,
  ResponsibilityArea,
  UpdateResponsibilityArea,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

type AreaRow = typeof responsibilityAreas.$inferSelect;
type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const TITLE_UNIQUE_INDEX = "responsibility_areas_company_title_uq";

export type ResponsibilityAreaCreateActor =
  | { type: "board" }
  | { type: "agent"; agentId: string };

export function toResponsibilityArea(row: AreaRow): ResponsibilityArea {
  return {
    ...row,
    status: row.status as ResponsibilityArea["status"],
    source: row.source as ResponsibilityArea["source"],
  };
}

function isTitleConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    if (maybe.code === "23505" && (maybe.constraint ?? maybe.constraint_name) === TITLE_UNIQUE_INDEX) return true;
    current = maybe.cause;
  }
  return false;
}

const AREA_ORDER = [
  asc(responsibilityAreas.sortOrder),
  asc(sql`lower(${responsibilityAreas.title})`),
  asc(responsibilityAreas.createdAt),
  asc(responsibilityAreas.id),
] as const;

/**
 * Areas: broad nouns a company cares about. No owner. Board users manage them;
 * agents can only propose one (idempotently, by case-insensitive title).
 */
export function responsibilityAreaService(db: Db) {
  async function findLiveByTitle(companyId: string, title: string, database: DbOrTransaction = db) {
    return database.select().from(responsibilityAreas)
      .where(and(
        eq(responsibilityAreas.companyId, companyId),
        sql`lower(${responsibilityAreas.title}) = lower(${title})`,
        ne(responsibilityAreas.status, "archived"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  return {
    getById: (id: string) =>
      db.select().from(responsibilityAreas).where(eq(responsibilityAreas.id, id)).then((rows) => rows[0] ?? null),

    async getInCompany(companyId: string, id: string, database: DbOrTransaction = db) {
      return database.select().from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.id, id), eq(responsibilityAreas.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
    },

    async list(companyId: string, opts: { includeArchived?: boolean } = {}): Promise<ResponsibilityArea[]> {
      const rows = await db.select().from(responsibilityAreas)
        .where(and(
          eq(responsibilityAreas.companyId, companyId),
          opts.includeArchived ? undefined : ne(responsibilityAreas.status, "archived"),
        ))
        .orderBy(...AREA_ORDER);
      return rows.map(toResponsibilityArea);
    },

    /** Active areas in the company plus the listed ids (whatever their status). */
    async listActiveAnd(companyId: string, ids: readonly string[]): Promise<ResponsibilityArea[]> {
      const rows = await db.select().from(responsibilityAreas)
        .where(and(
          eq(responsibilityAreas.companyId, companyId),
          ids.length > 0
            ? or(eq(responsibilityAreas.status, "active"), inArray(responsibilityAreas.id, [...ids]))
            : eq(responsibilityAreas.status, "active"),
        ))
        .orderBy(...AREA_ORDER);
      return rows.map(toResponsibilityArea);
    },

    /**
     * Create an area, or return the non-archived one that already has this
     * title (case-insensitive). Board: `active` unless told otherwise. Agent:
     * always `proposed`, source `onboarding`.
     */
    async create(
      companyId: string,
      input: CreateResponsibilityArea,
      actor: ResponsibilityAreaCreateActor,
    ): Promise<{ area: ResponsibilityArea; created: boolean }> {
      const existing = await findLiveByTitle(companyId, input.title);
      if (existing) return { area: toResponsibilityArea(existing), created: false };
      const values: typeof responsibilityAreas.$inferInsert = {
        companyId,
        title: input.title,
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? 0,
        ...(actor.type === "agent"
          ? { status: "proposed", source: "onboarding", proposedByAgentId: actor.agentId }
          : { status: input.status ?? "active", source: input.source ?? "manual", proposedByAgentId: null }),
      };
      try {
        const [row] = await db.insert(responsibilityAreas).values(values).returning();
        return { area: toResponsibilityArea(row!), created: true };
      } catch (error) {
        if (!isTitleConflict(error)) throw error;
        // A concurrent request created the same title first; return it.
        const winner = await findLiveByTitle(companyId, input.title);
        if (!winner) throw error;
        return { area: toResponsibilityArea(winner), created: false };
      }
    },

    async update(existing: AreaRow, patch: UpdateResponsibilityArea): Promise<ResponsibilityArea> {
      const set: Partial<typeof responsibilityAreas.$inferInsert> = { updatedAt: new Date() };
      for (const key of ["title", "description", "sortOrder", "status"] as const) {
        if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key];
      }
      const nextTitle = patch.title ?? existing.title;
      const nextStatus = patch.status ?? existing.status;
      if (nextStatus !== "archived" && (patch.title !== undefined || patch.status !== undefined)) {
        const clash = await findLiveByTitle(existing.companyId, nextTitle);
        if (clash && clash.id !== existing.id) {
          throw conflict(`Another area is already called "${clash.title}"`, { areaId: clash.id });
        }
      }
      try {
        const [row] = await db.update(responsibilityAreas).set(set)
          .where(and(eq(responsibilityAreas.id, existing.id), eq(responsibilityAreas.companyId, existing.companyId)))
          .returning();
        if (!row) throw notFound("Area not found");
        return toResponsibilityArea(row);
      } catch (error) {
        if (isTitleConflict(error)) throw conflict(`Another area is already called "${nextTitle}"`);
        throw error;
      }
    },

    /** Responsibilities under it keep existing with `areaId` null (FK on delete set null). */
    async remove(existing: AreaRow): Promise<ResponsibilityArea | null> {
      const [row] = await db.delete(responsibilityAreas)
        .where(and(eq(responsibilityAreas.id, existing.id), eq(responsibilityAreas.companyId, existing.companyId)))
        .returning();
      return row ? toResponsibilityArea(row) : null;
    },

    /** Inside `tx`: make a proposed area active. Returns the area when it changed. */
    async activateIfProposed(tx: DbOrTransaction, companyId: string, areaId: string): Promise<ResponsibilityArea | null> {
      const [row] = await tx.update(responsibilityAreas)
        .set({ status: "active", updatedAt: new Date() })
        .where(and(
          eq(responsibilityAreas.id, areaId),
          eq(responsibilityAreas.companyId, companyId),
          eq(responsibilityAreas.status, "proposed"),
        ))
        .returning();
      return row ? toResponsibilityArea(row) : null;
    },
  };
}
