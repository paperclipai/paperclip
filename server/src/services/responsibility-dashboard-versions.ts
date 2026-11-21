import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySkills, issues, projects, responsibilities, responsibilityAreas, responsibilityDashboardVersions, responsibilityLinks, routines } from "@paperclipai/db";
import {
  RESPONSIBILITY_DASHBOARD_UNDO_HOURS,
  RESPONSIBILITY_DASHBOARD_VERSION_LIMIT,
  responsibilityDashboardChangeSummary,
  responsibilityDashboardSnapshotSchema,
  type ResponsibilityDashboardSnapshot,
  type ResponsibilityDashboardSnapshotArea,
  type ResponsibilityDashboardSnapshotLinks,
  type ResponsibilityDashboardVersionCause,
  type ResponsibilityDashboardVersionList,
  type ResponsibilityDashboardVersionSummary,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { skillAccessService } from "./skill-access.js";

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
    interactionId: row.interactionId,
    previousVersionId: row.previousVersionId,
    restoredFromVersionId: row.restoredFromVersionId,
    createdAt: row.createdAt,
  };
}

export function parseDashboardSnapshot(value: unknown): ResponsibilityDashboardSnapshot {
  return responsibilityDashboardSnapshotSchema.parse(value) as ResponsibilityDashboardSnapshot;
}

/**
 * Identity of a snapshot's contents: the areas and responsibilities, never
 * which areas a change created. A snapshot whose responsibilities hold what is
 * filed under them hashes those too; `legacy` leaves them out, to compare with
 * a version saved before snapshots held them.
 */
export function dashboardSnapshotHash(snapshot: ResponsibilityDashboardSnapshot, opts: { legacy?: boolean } = {}): string {
  const areas = [...snapshot.areas].sort((a, b) => a.id.localeCompare(b.id))
    .map((area) => opts.legacy || area.description === undefined
      ? [area.id, area.title, area.status, area.sortOrder]
      : [area.id, area.title, area.status, area.sortOrder, area.description]);
  const items = [...snapshot.responsibilities].sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => {
      const base: unknown[] = [item.id, item.title, item.standard, item.areaId, item.status, item.sortOrder];
      if (opts.legacy || !item.links) return base;
      // No filed skills hashes like a version saved before skills could be filed.
      const links = { ...item.links, skillIds: item.links.skillIds?.length ? item.links.skillIds : undefined };
      return [...base, links, item.description ?? null, item.runByAgentId ?? null,
        item.evidence ?? null, item.healthOverride ?? null, item.healthNote ?? null];
    });
  return createHash("sha256").update(JSON.stringify({ areas, items })).digest("hex");
}

/** True for a version saved before snapshots held filed items. */
function isLegacySnapshot(snapshot: ResponsibilityDashboardSnapshot) {
  return snapshot.responsibilities.some((item) => item.links === undefined);
}

/** True for a version saved before snapshots held filed skills: restoring it would leave filed skills alone. */
function lacksFiledSkills(snapshot: ResponsibilityDashboardSnapshot) {
  return snapshot.responsibilities.some((item) => item.links !== undefined && item.links.skillIds === undefined);
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
    const [rows, linkRows] = await Promise.all([
      database.select({
        id: responsibilities.id,
        title: responsibilities.title,
        standard: responsibilities.standard,
        areaId: responsibilities.areaId,
        status: responsibilities.status,
        sortOrder: responsibilities.sortOrder,
        description: responsibilities.description,
        runByAgentId: responsibilities.runByAgentId,
        evidence: responsibilities.evidence,
        healthOverride: responsibilities.healthOverride,
        healthNote: responsibilities.healthNote,
      }).from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.ownerUserId, ownerUserId),
        eq(responsibilities.status, "active"),
      )),
      database.select({
        responsibilityId: responsibilityLinks.responsibilityId,
        projectId: responsibilityLinks.projectId,
        issueId: responsibilityLinks.issueId,
        routineId: responsibilityLinks.routineId,
        skillId: responsibilityLinks.skillId,
      }).from(responsibilityLinks)
        .innerJoin(responsibilities, eq(responsibilities.id, responsibilityLinks.responsibilityId))
        .where(and(
          eq(responsibilities.companyId, companyId),
          eq(responsibilities.ownerUserId, ownerUserId),
          eq(responsibilities.status, "active"),
        )),
    ]);
    const linksBy = new Map<string, ResponsibilityDashboardSnapshotLinks>();
    for (const link of linkRows) {
      const entry = linksBy.get(link.responsibilityId) ?? { projectIds: [], issueIds: [], routineIds: [], skillIds: [] };
      if (link.projectId) entry.projectIds.push(link.projectId);
      if (link.issueId) entry.issueIds.push(link.issueId);
      if (link.routineId) entry.routineIds.push(link.routineId);
      if (link.skillId) entry.skillIds!.push(link.skillId);
      linksBy.set(link.responsibilityId, entry);
    }
    const sortedLinks = (id: string): ResponsibilityDashboardSnapshotLinks => {
      const entry = linksBy.get(id) ?? { projectIds: [], issueIds: [], routineIds: [], skillIds: [] };
      return {
        projectIds: [...entry.projectIds].sort(), issueIds: [...entry.issueIds].sort(),
        routineIds: [...entry.routineIds].sort(), skillIds: [...(entry.skillIds ?? [])].sort(),
      };
    };
    const items = rows.map(({ description, runByAgentId, evidence, healthOverride, healthNote, ...item }) => ({
      ...item, links: sortedLinks(item.id), description, runByAgentId, evidence, healthOverride, healthNote,
    }));
    const referenced = [...new Set(items.map((item) => item.areaId).filter((value): value is string => value !== null))];
    // An area a change is about to touch is held whatever its status, so undoing a restore archives it again.
    const touchedIds = touched.filter((value) => !referenced.includes(value));
    const areas = await database.select({
      id: responsibilityAreas.id,
      title: responsibilityAreas.title,
      status: responsibilityAreas.status,
      sortOrder: responsibilityAreas.sortOrder,
      description: responsibilityAreas.description,
    }).from(responsibilityAreas).where(and(
      eq(responsibilityAreas.ownerUserId, ownerUserId), eq(responsibilityAreas.companyId, companyId),
      or(
        referenced.length > 0 ? inArray(responsibilityAreas.id, referenced) : undefined,
        ne(responsibilityAreas.status, "archived"),
        touchedIds.length > 0 ? inArray(responsibilityAreas.id, touchedIds) : undefined,
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
    const previousSnapshot = previous ? parseDashboardSnapshot(previous.snapshot) : null;
    const hash = dashboardSnapshotHash(input.snapshot);
    // A version saved before snapshots held filed items is compared on what it holds.
    const legacy = previousSnapshot ? isLegacySnapshot(previousSnapshot) : false;
    const comparable = legacy ? dashboardSnapshotHash(input.snapshot, { legacy: true }) : hash;
    const previousHash = previous?.snapshotHash === "remapped" && previousSnapshot
      ? dashboardSnapshotHash(previousSnapshot, { legacy }) : previous?.snapshotHash;
    if (previous && previousHash === comparable) {
      // One saved before skills could be filed hashes the same (no filed skills) but must hold the empty list too.
      if (!legacy && !lacksFiledSkills(previousSnapshot!)) return { row: previous, created: false };
      // The same dashboard as an older version that held no filed items,
      // details or skills: it now holds them, so the next change compares, and undoes, in full.
      const [upgraded] = await tx.update(responsibilityDashboardVersions)
        .set({ snapshot: input.snapshot as unknown as Record<string, unknown>, snapshotHash: hash })
        .where(eq(responsibilityDashboardVersions.id, previous.id))
        .returning();
      return { row: upgraded ?? previous, created: false };
    }
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
   * deleted, and bars, metrics and readings are never touched. A version that
   * holds what is filed under each responsibility, its description and the
   * agent that runs it puts those back too (see restoreDetailsInTx); an older
   * version leaves them as they are.
   *
   * A responsibility deleted since is created again with
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
    const [areaRows, liveAreas, ownRows] = await Promise.all([
      areaIds.length === 0 ? Promise.resolve([] as AreaRow[]) : tx.select().from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.ownerUserId, ownerUserId), eq(responsibilityAreas.companyId, companyId), inArray(responsibilityAreas.id, areaIds))),
      tx.select({ id: responsibilityAreas.id, title: responsibilityAreas.title }).from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.ownerUserId, ownerUserId), eq(responsibilityAreas.companyId, companyId), ne(responsibilityAreas.status, "archived"))),
      targetItemIds.length === 0 ? Promise.resolve([] as ResponsibilityRow[]) : tx.select().from(responsibilities).where(and(
        eq(responsibilities.companyId, companyId),
        eq(responsibilities.ownerUserId, ownerUserId),
        inArray(responsibilities.id, targetItemIds),
      )),
    ]);
    const areasById = new Map(areaRows.map((row) => [row.id, row]));
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
          companyId, ownerUserId,
          title: want.title,
          description: want.description ?? null,
          status: want.status === "archived" ? "archived" : "active",
          sortOrder: want.sortOrder,
        }).returning();
        areaFor.set(want.id, created!.id);
        createdAreaIds.push(created!.id);
        setLive(created!);
        events.push({ action: "responsibility_area.created", entityType: "responsibility_area", entityId: created!.id, details: { title: created!.title, status: created!.status, ...source } });
        return true;
      }
      const { title: nextTitle, status: nextStatus, sortOrder: nextOrder } = want;
      const nextDescription = want.description === undefined ? row.description : want.description;
      if (nextTitle === row.title && nextStatus === row.status && nextOrder === row.sortOrder && nextDescription === row.description) {
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
        .set({ title: nextTitle, status: nextStatus, sortOrder: nextOrder, description: nextDescription, updatedAt: now })
        .where(and(eq(responsibilityAreas.id, row.id), eq(responsibilityAreas.ownerUserId, ownerUserId), eq(responsibilityAreas.companyId, companyId)))
        .returning();
      areasById.set(row.id, updated!);
      setLive(updated!);
      areaFor.set(want.id, row.id);
      events.push({
        action: "responsibility_area.updated",
        entityType: "responsibility_area",
        entityId: row.id,
        details: {
          fields: [
            nextTitle !== row.title ? "title" : null, nextStatus !== row.status ? "status" : null,
            nextOrder !== row.sortOrder ? "sortOrder" : null, nextDescription !== row.description ? "description" : null,
          ].filter(Boolean),
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
        events.push(...await restoreDetailsInTx(tx, companyId, created!, want, source));
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
      events.push(...await restoreDetailsInTx(tx, companyId, row, want, source));
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
    events.push(...await archiveIfEmpty(tx, companyId, ownerUserId, candidates, source));
    return { events, createdAreaIds };
  }

  /**
   * Inside `tx`: put back what a version holds beyond the sentence fields,
   * when it holds them: the description, the agent that runs it (while that
   * agent still exists) and exactly the projects, tasks and routines filed
   * directly under it (those deleted since stay gone).
   */
  async function restoreDetailsInTx(
    tx: DashboardTransaction,
    companyId: string,
    row: Pick<ResponsibilityRow, "id" | "description" | "runByAgentId" | "evidence" | "healthOverride" | "healthNote">,
    want: ResponsibilityDashboardSnapshot["responsibilities"][number],
    source: Record<string, unknown>,
  ): Promise<DashboardActivityEvent[]> {
    const events: DashboardActivityEvent[] = [];
    const set: Partial<typeof responsibilities.$inferInsert> = {};
    if (want.description !== undefined && (row.description ?? null) !== want.description) set.description = want.description;
    if (want.evidence !== undefined && (row.evidence ?? null) !== want.evidence) set.evidence = want.evidence;
    if (want.healthOverride !== undefined && (row.healthOverride ?? null) !== want.healthOverride) set.healthOverride = want.healthOverride;
    if (want.healthNote !== undefined && (row.healthNote ?? null) !== want.healthNote) set.healthNote = want.healthNote;
    if (want.runByAgentId !== undefined && row.runByAgentId !== want.runByAgentId) {
      const agentExists = want.runByAgentId === null || (await tx.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, want.runByAgentId), eq(agents.companyId, companyId)))).length > 0;
      if (agentExists) set.runByAgentId = want.runByAgentId;
    }
    if (Object.keys(set).length > 0) {
      await tx.update(responsibilities).set({ ...set, updatedAt: new Date() })
        .where(and(eq(responsibilities.id, row.id), eq(responsibilities.companyId, companyId)));
      events.push({
        action: "responsibility.updated",
        entityType: "responsibility",
        entityId: row.id,
        details: {
          fields: Object.keys(set),
          ...(set.runByAgentId !== undefined ? { fromRunByAgentId: row.runByAgentId, toRunByAgentId: set.runByAgentId } : {}),
          ...source,
        },
      });
    }
    if (!want.links) return events;
    // A version saved before skills could be filed leaves filed skills as they are.
    const withSkills = want.links.skillIds !== undefined;
    const linked = await tx.select().from(responsibilityLinks).where(eq(responsibilityLinks.responsibilityId, row.id));
    // Skills the person restoring cannot see (the request's actor) are left as they are: not filed again, not removed.
    const skillIds = [...new Set([...linked.flatMap((link) => (link.skillId ? [link.skillId] : [])), ...(want.links.skillIds ?? [])])];
    const visibleSkills = !withSkills || skillIds.length === 0 ? new Set<string>() : new Set(
      (await tx.select({ id: companySkills.id }).from(companySkills).where(and(
        eq(companySkills.companyId, companyId), inArray(companySkills.id, skillIds),
        await skillAccessService(tx as unknown as Db).condition(companyId),
      ))).map((skill) => skill.id),
    );
    const current = linked.filter((link) => !link.skillId || visibleSkills.has(link.skillId));
    const wanted = new Set([
      ...want.links.projectIds.map((id) => `project:${id}`),
      ...want.links.issueIds.map((id) => `issue:${id}`),
      ...want.links.routineIds.map((id) => `routine:${id}`),
      ...(want.links.skillIds ?? []).filter((id) => visibleSkills.has(id)).map((id) => `skill:${id}`),
    ]);
    const keyOf = (link: typeof responsibilityLinks.$inferSelect) =>
      link.projectId ? `project:${link.projectId}` : link.issueId ? `issue:${link.issueId}`
        : link.routineId ? `routine:${link.routineId}` : `skill:${link.skillId}`;
    const have = new Set(current.map(keyOf));
    for (const link of current) {
      if (wanted.has(keyOf(link))) continue;
      await tx.delete(responsibilityLinks).where(eq(responsibilityLinks.id, link.id));
      const [targetType, targetId] = keyOf(link).split(":");
      events.push({ action: "responsibility.unlinked", entityType: "responsibility", entityId: row.id, details: { linkId: link.id, targetType, targetId, ...source } });
    }
    const missing = [...wanted].filter((key) => !have.has(key)).map((key) => key.split(":") as [string, string]);
    const idsOf = (kind: string) => missing.filter(([type]) => type === kind).map(([, id]) => id);
    // Only items that still exist in the company can be filed again.
    const [liveProjects, liveIssues, liveRoutines, liveSkills] = await Promise.all([
      idsOf("project").length === 0 ? [] : tx.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, idsOf("project")))),
      idsOf("issue").length === 0 ? [] : tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, idsOf("issue")))),
      idsOf("routine").length === 0 ? [] : tx.select({ id: routines.id }).from(routines)
        .where(and(eq(routines.companyId, companyId), inArray(routines.id, idsOf("routine")))),
      idsOf("skill").length === 0 ? [] : tx.select({ id: companySkills.id }).from(companySkills)
        .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.id, idsOf("skill")))),
    ]);
    const live = new Set([
      ...liveProjects.map((item) => `project:${item.id}`),
      ...liveIssues.map((item) => `issue:${item.id}`),
      ...liveRoutines.map((item) => `routine:${item.id}`),
      ...liveSkills.map((item) => `skill:${item.id}`),
    ]);
    for (const [kind, id] of missing) {
      if (!live.has(`${kind}:${id}`)) continue;
      const [inserted] = await tx.insert(responsibilityLinks).values({
        companyId,
        responsibilityId: row.id,
        projectId: kind === "project" ? id : null,
        issueId: kind === "issue" ? id : null,
        routineId: kind === "routine" ? id : null,
        skillId: kind === "skill" ? id : null,
      }).onConflictDoNothing().returning();
      if (inserted) events.push({ action: "responsibility.linked", entityType: "responsibility", entityId: row.id, details: { linkId: inserted.id, targetType: kind, targetId: id, ...source } });
    }
    return events;
  }

  /** Inside `tx`: archive each listed area that is not archived and holds no proposed or active responsibility of anyone. */
  async function archiveIfEmpty(tx: DashboardTransaction, companyId: string, ownerUserId: string, areaIds: readonly string[], source: Record<string, unknown>) {
    if (areaIds.length === 0) return [];
    const archived = await tx.update(responsibilityAreas).set({ status: "archived", updatedAt: new Date() }).where(and(
      eq(responsibilityAreas.ownerUserId, ownerUserId), eq(responsibilityAreas.companyId, companyId),
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
