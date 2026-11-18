import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { responsibilities, responsibilityAreas, responsibilityDashboardVersions } from "@paperclipai/db";
import {
  RESPONSIBILITY_DASHBOARD_UNDO_HOURS,
  RESPONSIBILITY_DASHBOARD_VERSION_LIMIT,
  responsibilityDashboardChangeSummary,
  responsibilityDashboardSnapshotSchema,
  type ResponsibilityDashboardSnapshot,
  type ResponsibilityDashboardSnapshotArea,
  type ResponsibilityDashboardVersionCause,
  type ResponsibilityDashboardVersionList,
  type ResponsibilityDashboardVersionSummary,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

/**
 * Versions of a person's Dashboard (experimental `enableResponsibilities`).
 * This module owns what a snapshot holds, when one is saved, the bounded
 * history and what restoring one does. The change sets that cause most
 * versions belong to responsibility-dashboard.ts, which calls in here inside
 * its own transaction.
 *
 * Every write for one person runs under the same transaction-scoped advisory
 * lock, so a restore, an applied change set and a checkpoint never interleave.
 */

export type DashboardTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | DashboardTransaction;
type VersionRow = typeof responsibilityDashboardVersions.$inferSelect;
type AreaRow = typeof responsibilityAreas.$inferSelect;
type ResponsibilityRow = typeof responsibilities.$inferSelect;

const LIVE = ["proposed", "active"] as const;

/** One activity entry a restore or an applied change set writes after commit. */
export interface DashboardActivityEvent {
  action: string;
  entityType: "responsibility" | "responsibility_area";
  entityId: string;
  details: Record<string, unknown>;
}

export function toDashboardVersionSummary(row: VersionRow): ResponsibilityDashboardVersionSummary {
  return {
    id: row.id,
    cause: row.cause as ResponsibilityDashboardVersionCause,
    summary: row.summary,
    actorUserId: row.actorUserId,
    actorAgentId: row.actorAgentId,
    previousVersionId: row.previousVersionId,
    restoredFromVersionId: row.restoredFromVersionId,
    createdAt: row.createdAt,
  };
}

export function parseDashboardSnapshot(value: unknown): ResponsibilityDashboardSnapshot {
  return responsibilityDashboardSnapshotSchema.parse(value) as ResponsibilityDashboardSnapshot;
}

/** Identity of a snapshot's contents: the areas and responsibilities, never which areas a change created. */
export function dashboardSnapshotHash(snapshot: ResponsibilityDashboardSnapshot): string {
  const areas = [...snapshot.areas].sort((a, b) => a.id.localeCompare(b.id))
    .map((area) => [area.id, area.title, area.status, area.sortOrder]);
  const items = [...snapshot.responsibilities].sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => [item.id, item.title, item.standard, item.areaId, item.status, item.sortOrder]);
  return createHash("sha256").update(JSON.stringify({ areas, items })).digest("hex");
}

/** Serialize all dashboard writes for one person inside `tx`. */
export async function lockDashboard(tx: DashboardTransaction, companyId: string, ownerUserId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`responsibility-dashboard:${companyId}:${ownerUserId}`}, 0))`);
}

function lower(value: string) {
  return value.trim().toLowerCase();
}

export function responsibilityDashboardVersionService(db: Db) {
  /**
   * The person's dashboard as it is: every responsibility they own that is
   * active, every area one of them is in, and every area a change on this
   * dashboard created that is not archived (an empty one still shows, so it
   * must be undoable), plus any area in `touched` that is not archived: an
   * existing area a change is about to rename or remove, even when it holds
   * nothing of this person's. Three queries at most.
   */
  async function captureSnapshot(
    database: DbOrTx,
    companyId: string,
    ownerUserId: string,
    /** Areas the change being saved created, which no stored version names yet. */
    createdNow: readonly string[] = [],
    touched: readonly string[] = [],
  ): Promise<ResponsibilityDashboardSnapshot> {
    const [items, created] = await Promise.all([
      database.select({
        id: responsibilities.id,
        title: responsibilities.title,
        standard: responsibilities.standard,
        areaId: responsibilities.areaId,
        status: responsibilities.status,
        sortOrder: responsibilities.sortOrder,
      }).from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.ownerUserId, ownerUserId),
        eq(responsibilities.status, "active"),
      )),
      database.selectDistinct({ id: sql<string>`jsonb_array_elements_text(${responsibilityDashboardVersions.snapshot} -> 'createdAreaIds')` })
        .from(responsibilityDashboardVersions)
        .where(and(
          eq(responsibilityDashboardVersions.companyId, companyId),
          eq(responsibilityDashboardVersions.ownerUserId, ownerUserId),
        )),
    ]);
    const referenced = [...new Set(items.map((item) => item.areaId).filter((value): value is string => value !== null))];
    const createdIds = [...new Set([...created.map((row) => row.id), ...createdNow, ...touched])].filter((value) => !referenced.includes(value));
    const areas = referenced.length + createdIds.length === 0 ? [] : await database.select({
      id: responsibilityAreas.id,
      title: responsibilityAreas.title,
      status: responsibilityAreas.status,
      sortOrder: responsibilityAreas.sortOrder,
    }).from(responsibilityAreas).where(and(
      eq(responsibilityAreas.companyId, companyId),
      or(
        referenced.length > 0 ? inArray(responsibilityAreas.id, referenced) : undefined,
        createdIds.length > 0 ? and(inArray(responsibilityAreas.id, createdIds), ne(responsibilityAreas.status, "archived")) : undefined,
      ),
    ));
    return {
      version: 1,
      areas: areas.sort((a, b) => a.id.localeCompare(b.id)),
      responsibilities: items.sort((a, b) => a.id.localeCompare(b.id)),
      createdAreaIds: [...createdNow],
    };
  }

  async function latestRow(database: DbOrTx, companyId: string, ownerUserId: string): Promise<VersionRow | null> {
    const [row] = await database.select().from(responsibilityDashboardVersions).where(and(
      eq(responsibilityDashboardVersions.companyId, companyId),
      eq(responsibilityDashboardVersions.ownerUserId, ownerUserId),
    )).orderBy(desc(responsibilityDashboardVersions.createdAt), desc(responsibilityDashboardVersions.id)).limit(1);
    return row ?? null;
  }

  async function prune(tx: DashboardTransaction, companyId: string, ownerUserId: string) {
    const keep = tx.select({ id: responsibilityDashboardVersions.id }).from(responsibilityDashboardVersions).where(and(
      eq(responsibilityDashboardVersions.companyId, companyId),
      eq(responsibilityDashboardVersions.ownerUserId, ownerUserId),
    )).orderBy(desc(responsibilityDashboardVersions.createdAt), desc(responsibilityDashboardVersions.id))
      .limit(RESPONSIBILITY_DASHBOARD_VERSION_LIMIT);
    await tx.delete(responsibilityDashboardVersions).where(and(
      eq(responsibilityDashboardVersions.companyId, companyId),
      eq(responsibilityDashboardVersions.ownerUserId, ownerUserId),
      notInArray(responsibilityDashboardVersions.id, keep),
    ));
  }

  /**
   * Save `snapshot` as the newest version, unless it is identical to the
   * newest one (then that one is returned). The summary says what changed
   * since the newest one. Prunes past the limit.
   */
  async function save(tx: DashboardTransaction, input: {
    companyId: string;
    ownerUserId: string;
    cause: ResponsibilityDashboardVersionCause;
    snapshot: ResponsibilityDashboardSnapshot;
    actorUserId?: string | null;
    actorAgentId?: string | null;
    issueId?: string | null;
    interactionId?: string | null;
    restoredFromVersionId?: string | null;
  }): Promise<{ row: VersionRow; created: boolean }> {
    const previous = await latestRow(tx, input.companyId, input.ownerUserId);
    const hash = dashboardSnapshotHash(input.snapshot);
    if (previous && previous.snapshotHash === hash) return { row: previous, created: false };
    const summary = responsibilityDashboardChangeSummary(previous ? parseDashboardSnapshot(previous.snapshot) : null, input.snapshot);
    // Strictly after the previous version, so "newest" never ties within one transaction.
    const createdAt = new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1));
    const [row] = await tx.insert(responsibilityDashboardVersions).values({
      companyId: input.companyId,
      ownerUserId: input.ownerUserId,
      cause: input.cause,
      summary,
      snapshot: input.snapshot as unknown as Record<string, unknown>,
      snapshotHash: hash,
      actorUserId: input.actorUserId ?? null,
      actorAgentId: input.actorAgentId ?? null,
      issueId: input.issueId ?? null,
      interactionId: input.interactionId ?? null,
      previousVersionId: previous?.id ?? null,
      restoredFromVersionId: input.restoredFromVersionId ?? null,
      createdAt,
    }).returning();
    await prune(tx, input.companyId, input.ownerUserId);
    return { row: row!, created: true };
  }

  /**
   * Inside `tx`, holding the person's lock: save the dashboard as it is now
   * as a `person` version when it differs from the newest one (changes made by
   * hand since), so the version before the next change is what they last saw.
   */
  async function checkpoint(
    tx: DashboardTransaction,
    companyId: string,
    ownerUserId: string,
    actorUserId: string | null,
    touched: readonly string[] = [],
  ) {
    const snapshot = await captureSnapshot(tx, companyId, ownerUserId, [], touched);
    const saved = await save(tx, { companyId, ownerUserId, cause: "person", snapshot, actorUserId });
    return { ...saved, snapshot };
  }

  /**
   * Inside `tx`: put the person's dashboard back to `target`. For every area
   * and responsibility in it, its name or sentence, area, order and status
   * are put back; whatever the person owns now that is not in it is let go,
   * and an area it leaves holding nothing of anyone's is archived. Nothing is
   * deleted, and bars, metrics, readings and what is filed under a
   * responsibility are never touched.
   *
   * Areas other people have responsibilities in keep their name and order
   * (they see them too); a responsibility deleted since is created again with
   * its sentence; an area deleted since is created again (or the live area now
   * holding its name is used); when an area's old name is now another area's,
   * that area is used instead.
   */
  async function applySnapshotInTx(
    tx: DashboardTransaction,
    companyId: string,
    ownerUserId: string,
    target: ResponsibilityDashboardSnapshot,
    current: ResponsibilityDashboardSnapshot,
    source: Record<string, unknown>,
  ): Promise<{ events: DashboardActivityEvent[]; createdAreaIds: string[] }> {
    const events: DashboardActivityEvent[] = [];
    const createdAreaIds: string[] = [];
    const now = new Date();
    const areaIds = [...new Set([...target.areas.map((area) => area.id), ...current.areas.map((area) => area.id)])];
    const targetItemIds = target.responsibilities.map((item) => item.id);
    const [areaRows, liveAreas, othersByArea, ownRows] = await Promise.all([
      areaIds.length === 0 ? Promise.resolve([] as AreaRow[]) : tx.select().from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.companyId, companyId), inArray(responsibilityAreas.id, areaIds))),
      tx.select({ id: responsibilityAreas.id, title: responsibilityAreas.title }).from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.companyId, companyId), ne(responsibilityAreas.status, "archived"))),
      areaIds.length === 0 ? Promise.resolve([] as Array<{ areaId: string | null; count: number }>) : tx.select({
        areaId: responsibilities.areaId,
        count: sql<number>`count(*)::int`,
      }).from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        inArray(responsibilities.areaId, areaIds),
        ne(responsibilities.ownerUserId, ownerUserId),
        inArray(responsibilities.status, [...LIVE]),
      )).groupBy(responsibilities.areaId),
      targetItemIds.length === 0 ? Promise.resolve([] as ResponsibilityRow[]) : tx.select().from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.ownerUserId, ownerUserId),
        inArray(responsibilities.id, targetItemIds),
      )),
    ]);
    const areasById = new Map(areaRows.map((row) => [row.id, row]));
    const shared = new Set(othersByArea.filter((row) => row.areaId && row.count > 0).map((row) => row.areaId!));
    // Live titles, kept current as this restore renames and archives, for the one-live-name-per-area rule.
    const liveTitle = new Map(liveAreas.map((row) => [lower(row.title), row.id]));
    const setLive = (row: { id: string; title: string; status: string }) => {
      for (const [title, id] of liveTitle) if (id === row.id) liveTitle.delete(title);
      if (row.status !== "archived") liveTitle.set(lower(row.title), row.id);
    };

    // Areas: which area each of the snapshot's areas is now.
    const areaFor = new Map<string, string>();
    const pending: ResponsibilityDashboardSnapshotArea[] = [];
    const placeArea = async (want: ResponsibilityDashboardSnapshotArea, final: boolean): Promise<boolean> => {
      const row = areasById.get(want.id);
      if (!row) {
        // Deleted since: use the live area that has its name, else create it again.
        const holder = liveTitle.get(lower(want.title));
        if (holder) {
          areaFor.set(want.id, holder);
          return true;
        }
        const [created] = await tx.insert(responsibilityAreas).values({
          companyId,
          title: want.title,
          status: want.status === "archived" ? "archived" : "active",
          sortOrder: want.sortOrder,
        }).returning();
        areaFor.set(want.id, created!.id);
        createdAreaIds.push(created!.id);
        setLive(created!);
        events.push({ action: "responsibility_area.created", entityType: "responsibility_area", entityId: created!.id, details: { title: created!.title, status: created!.status, ...source } });
        return true;
      }
      const isShared = shared.has(row.id);
      // Other people see a shared area: only bring it back if it was archived, never rename or reorder it.
      const nextTitle = isShared ? row.title : want.title;
      const nextStatus = isShared ? (row.status === "archived" && want.status !== "archived" ? "active" : row.status) : want.status;
      const nextOrder = isShared ? row.sortOrder : want.sortOrder;
      if (nextTitle === row.title && nextStatus === row.status && nextOrder === row.sortOrder) {
        areaFor.set(want.id, row.id);
        return true;
      }
      if (nextStatus !== "archived") {
        const holder = liveTitle.get(lower(nextTitle));
        if (holder && holder !== row.id) {
          if (!final) return false;
          // Its old name now belongs to another area: file the person's responsibilities there.
          areaFor.set(want.id, holder);
          return true;
        }
      }
      const [updated] = await tx.update(responsibilityAreas)
        .set({ title: nextTitle, status: nextStatus, sortOrder: nextOrder, updatedAt: now })
        .where(and(eq(responsibilityAreas.id, row.id), eq(responsibilityAreas.companyId, companyId)))
        .returning();
      areasById.set(row.id, updated!);
      setLive(updated!);
      areaFor.set(want.id, row.id);
      events.push({
        action: "responsibility_area.updated",
        entityType: "responsibility_area",
        entityId: row.id,
        details: {
          fields: [nextTitle !== row.title ? "title" : null, nextStatus !== row.status ? "status" : null, nextOrder !== row.sortOrder ? "sortOrder" : null].filter(Boolean),
          ...(nextTitle !== row.title ? { fromTitle: row.title, toTitle: nextTitle } : {}),
          ...(nextStatus !== row.status ? { fromStatus: row.status, toStatus: nextStatus } : {}),
          ...source,
        },
      });
      return true;
    };
    for (const want of target.areas) if (!(await placeArea(want, false))) pending.push(want);
    // A second pass: a name another area held may have been freed by the first.
    for (const want of pending) await placeArea(want, true);

    // Responsibilities in the snapshot: put each back.
    const ownById = new Map(ownRows.map((row) => [row.id, row]));
    // A deleted one comes back under its saved id, so restoring the same version again finds it
    // instead of making another copy. Its id is reused only while no other row holds it.
    const missingIds = targetItemIds.filter((id) => !ownById.has(id));
    const takenIds = new Set(missingIds.length === 0 ? [] : (await tx.select({ id: responsibilities.id }).from(responsibilities)
      .where(inArray(responsibilities.id, missingIds))).map((row) => row.id));
    const touchedAreas = new Set<string>();
    for (const want of target.responsibilities) {
      const areaId = want.areaId ? areaFor.get(want.areaId) ?? null : null;
      const row = ownById.get(want.id);
      if (!row) {
        // Deleted since: it comes back with its sentence (what was filed under it went with it).
        const [created] = await tx.insert(responsibilities).values({
          ...(takenIds.has(want.id) ? {} : { id: want.id }),
          companyId,
          ownerUserId,
          areaId,
          title: want.title,
          standard: want.standard,
          status: "active",
          source: "manual",
          sortOrder: want.sortOrder,
          metricDirection: null,
          confirmedAt: now,
        }).returning();
        events.push({ action: "responsibility.created", entityType: "responsibility", entityId: created!.id, details: { title: created!.title, ownerUserId, status: "active", source: "manual", areaId, ...source } });
        continue;
      }
      // A bar keeps its sentence: an empty one would leave its metric without the words it measures.
      const standard = want.standard === null && row.metricName ? row.standard : want.standard;
      const set: Partial<typeof responsibilities.$inferInsert> = {};
      if (row.title !== want.title) set.title = want.title;
      if ((row.standard ?? null) !== (standard ?? null)) set.standard = standard;
      if (row.areaId !== areaId) set.areaId = areaId;
      if (row.sortOrder !== want.sortOrder) set.sortOrder = want.sortOrder;
      if (row.status !== "active") {
        set.status = "active";
        if (!row.confirmedAt) set.confirmedAt = now;
      }
      if (Object.keys(set).length === 0) continue;
      await tx.update(responsibilities).set({ ...set, updatedAt: now })
        .where(and(eq(responsibilities.id, row.id), eq(responsibilities.companyId, companyId)));
      if (row.areaId) touchedAreas.add(row.areaId);
      events.push({
        action: "responsibility.updated",
        entityType: "responsibility",
        entityId: row.id,
        details: {
          fields: Object.keys(set).filter((key) => key !== "confirmedAt"),
          ...(set.status ? { fromStatus: row.status, toStatus: "active" } : {}),
          ...(set.areaId !== undefined ? { fromAreaId: row.areaId, toAreaId: areaId } : {}),
          ...source,
        },
      });
    }

    // What the person owns now that the snapshot does not hold: let go.
    const keep = new Set(target.responsibilities.map((item) => item.id));
    for (const item of current.responsibilities) {
      if (keep.has(item.id)) continue;
      const [updated] = await tx.update(responsibilities).set({ status: "let_go", updatedAt: now })
        .where(and(
          eq(responsibilities.id, item.id),
          eq(responsibilities.companyId, companyId),
          eq(responsibilities.ownerUserId, ownerUserId),
          eq(responsibilities.status, "active"),
        )).returning({ id: responsibilities.id });
      if (!updated) continue;
      if (item.areaId) touchedAreas.add(item.areaId);
      events.push({ action: "responsibility.updated", entityType: "responsibility", entityId: item.id, details: { fields: ["status"], fromStatus: "active", toStatus: "let_go", ...source } });
    }

    // Areas the snapshot does not hold that are now empty of anyone's live responsibilities: archived.
    const kept = new Set(areaFor.values());
    const candidates = [...new Set([...current.areas.map((area) => area.id), ...touchedAreas])].filter((areaId) => !kept.has(areaId));
    events.push(...await archiveIfEmpty(tx, companyId, candidates, source));
    return { events, createdAreaIds };
  }

  /** Inside `tx`: archive each listed area that is not archived and holds no proposed or active responsibility of anyone. */
  async function archiveIfEmpty(tx: DashboardTransaction, companyId: string, areaIds: readonly string[], source: Record<string, unknown>) {
    if (areaIds.length === 0) return [];
    const archived = await tx.update(responsibilityAreas).set({ status: "archived", updatedAt: new Date() }).where(and(
      eq(responsibilityAreas.companyId, companyId),
      inArray(responsibilityAreas.id, [...areaIds]),
      ne(responsibilityAreas.status, "archived"),
      sql`not exists (select 1 from ${responsibilities} r where r.area_id = ${responsibilityAreas.id} and r.status in ('proposed', 'active'))`,
    )).returning({ id: responsibilityAreas.id, title: responsibilityAreas.title, status: responsibilityAreas.status });
    return archived.map((row): DashboardActivityEvent => ({
      action: "responsibility_area.updated",
      entityType: "responsibility_area",
      entityId: row.id,
      details: { fields: ["status"], toStatus: "archived", title: row.title, ...source },
    }));
  }

  async function getInCompany(database: DbOrTx, companyId: string, versionId: string) {
    const [row] = await database.select().from(responsibilityDashboardVersions)
      .where(and(eq(responsibilityDashboardVersions.id, versionId), eq(responsibilityDashboardVersions.companyId, companyId)));
    return row ?? null;
  }

  return {
    captureSnapshot,
    save,
    checkpoint,
    applySnapshotInTx,
    archiveIfEmpty,

    getById: (versionId: string) =>
      db.select().from(responsibilityDashboardVersions).where(eq(responsibilityDashboardVersions.id, versionId))
        .then((rows) => rows[0] ?? null),

    /**
     * The newest version when it is an applied change set or a restore saved
     * within the Undo window, for the Dashboard's Undo line. One query.
     */
    async latestChange(companyId: string, ownerUserId: string, now: Date = new Date()): Promise<ResponsibilityDashboardVersionSummary | null> {
      const row = await latestRow(db, companyId, ownerUserId);
      if (!row || row.cause === "person" || !row.previousVersionId) return null;
      if (now.getTime() - row.createdAt.getTime() > RESPONSIBILITY_DASHBOARD_UNDO_HOURS * 3_600_000) return null;
      return toDashboardVersionSummary(row);
    },

    /**
     * The version list, newest first. With `checkpointBy` (someone who may
     * change this dashboard) the dashboard as it is now is saved first when
     * it changed by hand, so the list starts with what they see.
     */
    async list(companyId: string, ownerUserId: string, opts: { checkpointBy?: string | null } = {}): Promise<{ list: ResponsibilityDashboardVersionList; saved: VersionRow | null }> {
      let saved: VersionRow | null = null;
      if (opts.checkpointBy !== undefined) {
        saved = await db.transaction(async (tx) => {
          await lockDashboard(tx, companyId, ownerUserId);
          const result = await checkpoint(tx, companyId, ownerUserId, opts.checkpointBy ?? null);
          return result.created ? result.row : null;
        });
      }
      const rows = await db.select().from(responsibilityDashboardVersions).where(and(
        eq(responsibilityDashboardVersions.companyId, companyId),
        eq(responsibilityDashboardVersions.ownerUserId, ownerUserId),
      )).orderBy(desc(responsibilityDashboardVersions.createdAt), desc(responsibilityDashboardVersions.id))
        .limit(RESPONSIBILITY_DASHBOARD_VERSION_LIMIT);
      return { list: { ownerUserId, versions: rows.map(toDashboardVersionSummary) }, saved };
    },

    /**
     * Restore a version: the dashboard as it is now is saved first (when it
     * changed by hand), the version is applied, and the result is saved as a
     * new `restore` version whose previous version is the one before, so the
     * restore itself can be undone. Restoring the version that already
     * matches changes nothing and saves nothing.
     */
    async restore(version: VersionRow, actor: { userId: string | null }) {
      const target = parseDashboardSnapshot(version.snapshot);
      return db.transaction(async (tx) => {
        await lockDashboard(tx, version.companyId, version.ownerUserId);
        // Pruned between reading it and taking the lock: it is gone.
        if (!(await getInCompany(tx, version.companyId, version.id))) throw notFound("Version not found");
        const before = await checkpoint(tx, version.companyId, version.ownerUserId, actor.userId);
        const source = { source: "dashboard_restore", restoredVersionId: version.id };
        const { events, createdAreaIds } = await applySnapshotInTx(tx, version.companyId, version.ownerUserId, target, before.snapshot, source);
        const after = await captureSnapshot(tx, version.companyId, version.ownerUserId, createdAreaIds);
        const saved = await save(tx, {
          companyId: version.companyId,
          ownerUserId: version.ownerUserId,
          cause: "restore",
          snapshot: after,
          actorUserId: actor.userId,
          restoredFromVersionId: version.id,
        });
        return { version: saved.row, changed: saved.created, events };
      });
    },
  };
}
