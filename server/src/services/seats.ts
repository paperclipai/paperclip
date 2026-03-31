import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, backfillSeatModel, companyMemberships, issues, seatOccupancies, seats } from "@paperclipai/db";
import type { SeatPauseReason } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { delegatedPermissionsFromMetadata } from "./seat-permissions.js";
import {
  addSeatPauseReason,
  getSeatPauseInfo,
  isOperatorManagedSeatPauseReason,
  removeSeatPauseReason,
  type OperatorManagedSeatPauseReason,
} from "./seat-pause.js";

type SeatRow = typeof seats.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type DbExecutor = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface SeatOrgNode {
  id: string;
  seatId: string;
  name: string;
  role: string;
  seatType: string;
  operatingMode: string;
  status: string;
  reports: SeatOrgNode[];
}

export interface SeatMutationResult {
  seatId: string;
  companyId: string;
  previousOperatingMode?: string | null;
  operatingMode: string;
  currentHumanUserId: string | null;
  fallbackReassignedIssueCount: number;
}

export interface SeatModeReconcileResult {
  companyId: string;
  scannedSeatCount: number;
  updatedSeatCount: number;
}

export interface SeatDetail {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  title: string | null;
  seatType: string;
  status: string;
  pauseReason: SeatPauseReason | null;
  pauseReasons: SeatPauseReason[];
  operatingMode: string;
  currentHumanUserId: string | null;
  delegatedPermissions: string[];
  defaultAgentId: string | null;
}

export interface SeatListItem extends SeatDetail {}

export interface SeatPermissionsUpdateResult {
  seat: SeatDetail;
  previousDelegatedPermissions: string[];
}

function mapSeatStatus(seat: SeatRow, displayAgent: AgentRow | null): string {
  if (seat.status === "paused") return "paused";
  if (seat.status === "archived") return "terminated";
  return displayAgent?.status ?? "active";
}

function seatDetailFromRow(seat: SeatRow): SeatDetail {
  const pauseInfo = getSeatPauseInfo({
    status: seat.status,
    metadata: seat.metadata,
  });
  return {
    id: seat.id,
    companyId: seat.companyId,
    slug: seat.slug,
    name: seat.name,
    title: seat.title ?? null,
    seatType: seat.seatType,
    status: seat.status,
    pauseReason: pauseInfo.pauseReason,
    pauseReasons: pauseInfo.pauseReasons,
    operatingMode: seat.operatingMode,
    currentHumanUserId: seat.currentHumanUserId ?? null,
    delegatedPermissions: delegatedPermissionsFromMetadata(seat.metadata as Record<string, unknown> | null),
    defaultAgentId: seat.defaultAgentId ?? null,
  };
}

export function seatService(db: Db) {
  async function getById(seatId: string, executor: Pick<Db, "select"> = db) {
    return executor
      .select()
      .from(seats)
      .where(eq(seats.id, seatId))
      .then((rows) => rows[0] ?? null);
  }

  async function getDetail(companyId: string, seatId: string): Promise<SeatDetail | null> {
    const seat = await getById(seatId);
    if (!seat || seat.companyId !== companyId) return null;
    return seatDetailFromRow(seat);
  }

  async function listForCompany(companyId: string): Promise<SeatListItem[]> {
    const rows = await db
      .select()
      .from(seats)
      .where(eq(seats.companyId, companyId))
      .orderBy(asc(seats.createdAt), asc(seats.id));

    return rows.map((seat) => ({
      ...getSeatPauseInfo({
        status: seat.status,
        metadata: seat.metadata,
      }),
      id: seat.id,
      companyId: seat.companyId,
      slug: seat.slug,
      name: seat.name,
      title: seat.title ?? null,
      seatType: seat.seatType,
      status: seat.status,
      operatingMode: seat.operatingMode,
      currentHumanUserId: seat.currentHumanUserId ?? null,
      delegatedPermissions: delegatedPermissionsFromMetadata(seat.metadata as Record<string, unknown> | null),
      defaultAgentId: seat.defaultAgentId ?? null,
    }));
  }

  async function resolveOperatingMode(companyId: string, seatId: string, executor: Pick<Db, "select"> = db): Promise<string> {
    const rows = await executor
      .select({
        occupancyRole: seatOccupancies.occupancyRole,
        status: seatOccupancies.status,
      })
      .from(seatOccupancies)
      .where(and(eq(seatOccupancies.companyId, companyId), eq(seatOccupancies.seatId, seatId)));

    const activeRoles = new Set(
      rows
        .filter((row) => row.status === "active")
        .map((row) => row.occupancyRole),
    );

    if (activeRoles.has("human_operator") && activeRoles.has("shadow_agent")) return "shadowed";
    if (activeRoles.has("human_operator")) return "assisted";
    return "vacant";
  }

  function assertSeatIsActive(seat: SeatRow | null) {
    if (!seat) throw notFound("Seat not found");
    if (seat.status !== "active") throw conflict("Seat must be active");
  }

  function assertSeatIsMutable(seat: SeatRow | null) {
    if (!seat) throw notFound("Seat not found");
    if (seat.status === "archived") throw conflict("Seat must not be archived");
  }

  async function lockSeatForMutation(executor: DbExecutor, companyId: string, seatId: string) {
    await (executor as any).execute(
      sql`select id from seats where id = ${seatId} and company_id = ${companyId} for update`,
    );
    return getById(seatId, executor);
  }

  async function getAgentForSeatMutation(companyId: string, agentId: string, executor: Pick<Db, "select"> = db) {
    const agent = await executor
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.companyId !== companyId) throw unprocessable("Agent must belong to same company");
    if (agent.status === "pending_approval") throw conflict("Agent must not be pending approval");
    if (agent.status === "terminated") throw conflict("Agent must not be terminated");
    return agent;
  }

  async function hasActiveHumanOperator(companyId: string, seatId: string, executor: Pick<Db, "select"> = db) {
    const row = await executor
      .select({ id: seatOccupancies.id })
      .from(seatOccupancies)
      .where(
        and(
          eq(seatOccupancies.companyId, companyId),
          eq(seatOccupancies.seatId, seatId),
          eq(seatOccupancies.occupancyRole, "human_operator"),
          eq(seatOccupancies.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function assertActiveUserMembership(companyId: string, userId: string, executor: Pick<Db, "select"> = db) {
    const membership = await executor
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return membership;
  }

  return {
    getById,
    getDetail,
    listForCompany,

    backfillCompany: async (companyId: string) => backfillSeatModel(db, { companyId }),

    orgForCompany: async (companyId: string): Promise<SeatOrgNode[]> => {
      const seatRows = await db
        .select()
        .from(seats)
        .where(and(eq(seats.companyId, companyId), ne(seats.status, "archived")))
        .orderBy(asc(seats.createdAt), asc(seats.id));

      if (seatRows.length === 0) return [];

      const seatIds = seatRows.map((row) => row.id);
      const activePrimaryOccupancies = await db
        .select({
          seatId: seatOccupancies.seatId,
          occupantId: seatOccupancies.occupantId,
        })
        .from(seatOccupancies)
        .where(
          and(
            eq(seatOccupancies.companyId, companyId),
            inArray(seatOccupancies.seatId, seatIds),
            eq(seatOccupancies.occupantType, "agent"),
            eq(seatOccupancies.occupancyRole, "primary_agent"),
            eq(seatOccupancies.status, "active"),
          ),
        );

      const primaryAgentIdBySeatId = new Map(
        activePrimaryOccupancies
          .map((row) => {
            const occupantId = row.occupantId?.trim();
            return occupantId ? [row.seatId, occupantId] as const : null;
          })
          .filter((row): row is readonly [string, string] => row !== null),
      );

      const agentIds = Array.from(
        new Set(
          seatRows
            .flatMap((seat) => {
              const primary = primaryAgentIdBySeatId.get(seat.id) ?? null;
              return [primary, seat.defaultAgentId ?? null];
            })
            .filter((id): id is string => Boolean(id)),
        ),
      );

      const agentRows = agentIds.length === 0
        ? []
        : await db
          .select()
          .from(agents)
          .where(inArray(agents.id, agentIds));
      const agentById = new Map(agentRows.map((row) => [row.id, row]));

      const seatNodeById = new Map<string, SeatOrgNode>();
      for (const seat of seatRows) {
        const primaryAgentId = primaryAgentIdBySeatId.get(seat.id) ?? null;
        const displayAgent = (primaryAgentId ? agentById.get(primaryAgentId) : null)
          ?? (seat.defaultAgentId ? agentById.get(seat.defaultAgentId) : null)
          ?? null;
        seatNodeById.set(seat.id, {
          id: displayAgent?.id ?? seat.id,
          seatId: seat.id,
          name: seat.name,
          role: displayAgent?.role ?? seat.seatType,
          seatType: seat.seatType,
          operatingMode: seat.operatingMode,
          status: mapSeatStatus(seat, displayAgent),
          reports: [],
        });
      }

      const roots: SeatOrgNode[] = [];
      for (const seat of seatRows) {
        const node = seatNodeById.get(seat.id)!;
        if (seat.parentSeatId && seatNodeById.has(seat.parentSeatId)) {
          seatNodeById.get(seat.parentSeatId)!.reports.push(node);
        } else {
          roots.push(node);
        }
      }

      return roots;
    },

    reconcileModes: async (companyId: string): Promise<SeatModeReconcileResult> => {
      return db.transaction(async (tx) => {
        await (tx as any).execute(sql`select id from seats where company_id = ${companyId} for update`);
        const seatRows = await tx
          .select()
          .from(seats)
          .where(eq(seats.companyId, companyId));

        let updatedSeatCount = 0;
        for (const seat of seatRows) {
          const nextMode = await resolveOperatingMode(companyId, seat.id, tx);
          if (seat.operatingMode !== nextMode) {
            await tx
              .update(seats)
              .set({
                operatingMode: nextMode,
                updatedAt: new Date(),
              })
              .where(eq(seats.id, seat.id));
            updatedSeatCount += 1;
          }
        }

        return {
          companyId,
          scannedSeatCount: seatRows.length,
          updatedSeatCount,
        };
      });
    },

    updateDelegatedPermissions: async (
      companyId: string,
      seatId: string,
      delegatedPermissions: string[],
    ): Promise<SeatPermissionsUpdateResult | null> => {
      const updated = await db.transaction(async (tx) => {
        await (tx as any).execute(sql`select id from seats where id = ${seatId} and company_id = ${companyId} for update`);
        const seat = await tx
          .select()
          .from(seats)
          .where(eq(seats.id, seatId))
          .then((rows) => rows[0] ?? null);
        if (!seat || seat.companyId !== companyId) return null;
        const previousDelegatedPermissions = delegatedPermissionsFromMetadata(
          seat.metadata as Record<string, unknown> | null,
        );
        const metadata =
          seat.metadata && typeof seat.metadata === "object" && !Array.isArray(seat.metadata)
            ? { ...(seat.metadata as Record<string, unknown>) }
            : {};
        metadata.delegatedPermissions = delegatedPermissions;
        const updatedSeat = await tx
          .update(seats)
          .set({
            metadata,
            updatedAt: new Date(),
          })
          .where(eq(seats.id, seatId))
          .returning()
          .then((rows) => rows[0] ?? { ...seat, metadata, updatedAt: new Date() });
        return {
          seat: updatedSeat,
          previousDelegatedPermissions,
        };
      });
      if (!updated) return null;
      return {
        seat: seatDetailFromRow(updated.seat as SeatRow),
        previousDelegatedPermissions: updated.previousDelegatedPermissions,
      };
    },

    pauseSeat: async (
      companyId: string,
      seatId: string,
      pauseReason: OperatorManagedSeatPauseReason,
    ): Promise<SeatDetail | null> => {
      const updated = await db.transaction(async (tx) => {
        const seat = await lockSeatForMutation(tx, companyId, seatId);
        if (!seat || seat.companyId !== companyId) return null;
        assertSeatIsMutable(seat);
        const metadata = addSeatPauseReason({
          metadata: seat.metadata,
          currentStatus: seat.status,
          reason: pauseReason,
          now: new Date(),
        });
        const updatedSeat = await tx
          .update(seats)
          .set({
            status: "paused",
            metadata,
            updatedAt: new Date(),
          })
          .where(eq(seats.id, seatId))
          .returning()
          .then((rows) => rows[0] ?? { ...seat, status: "paused", metadata, updatedAt: new Date() });
        return updatedSeat;
      });
      if (!updated) return null;
      return seatDetailFromRow(updated as SeatRow);
    },

    resumeSeat: async (
      companyId: string,
      seatId: string,
      pauseReason: OperatorManagedSeatPauseReason | null,
    ): Promise<SeatDetail | null> => {
      const updated = await db.transaction(async (tx) => {
        const seat = await lockSeatForMutation(tx, companyId, seatId);
        if (!seat || seat.companyId !== companyId) return null;
        assertSeatIsMutable(seat);

        let pauseInfo = getSeatPauseInfo({
          status: seat.status,
          metadata: seat.metadata,
        });
        let nextMetadata = seat.metadata as Record<string, unknown> | null | undefined;
        const reasonsToRemove = pauseReason
          ? [pauseReason]
          : pauseInfo.pauseReasons.filter(isOperatorManagedSeatPauseReason);

        for (const reason of reasonsToRemove) {
          if (!pauseInfo.pauseReasons.includes(reason)) continue;
          const next = removeSeatPauseReason({
            metadata: nextMetadata,
            currentStatus: seat.status,
            reason,
          });
          pauseInfo = next;
          nextMetadata = next.metadata;
        }

        const nextStatus = pauseInfo.pauseReasons.length > 0 ? "paused" : "active";
        const updatedSeat = await tx
          .update(seats)
          .set({
            status: nextStatus,
            metadata: nextMetadata ?? null,
            updatedAt: new Date(),
          })
          .where(eq(seats.id, seatId))
          .returning()
          .then((rows) => rows[0] ?? { ...seat, status: nextStatus, metadata: nextMetadata ?? null, updatedAt: new Date() });
        return updatedSeat;
      });
      if (!updated) return null;
      return seatDetailFromRow(updated as SeatRow);
    },

    attachShadowAgent: async (companyId: string, seatId: string, agentId: string): Promise<SeatMutationResult> => {
      const now = new Date();
      let previousOperatingMode: string | null = null;
      let currentHumanUserId: string | null = null;
      let operatingMode = "vacant";

      await db.transaction(async (tx) => {
        const seat = await lockSeatForMutation(tx, companyId, seatId);
        if (!seat || seat.companyId !== companyId) throw notFound("Seat not found");
        assertSeatIsActive(seat);
        previousOperatingMode = seat.operatingMode;
        currentHumanUserId = seat.currentHumanUserId ?? null;
        await getAgentForSeatMutation(companyId, agentId, tx);
        const hasHuman = await hasActiveHumanOperator(companyId, seatId, tx);
        if (!hasHuman) {
          throw conflict("Shadow agent requires an active human operator");
        }
        const existingActive = await tx
          .select({ id: seatOccupancies.id })
          .from(seatOccupancies)
          .where(
            and(
              eq(seatOccupancies.companyId, companyId),
              eq(seatOccupancies.seatId, seatId),
              eq(seatOccupancies.occupancyRole, "shadow_agent"),
              eq(seatOccupancies.status, "active"),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existingActive) {
          await tx
            .update(seatOccupancies)
            .set({ status: "inactive", endsAt: now, updatedAt: now })
            .where(eq(seatOccupancies.id, existingActive.id));
        }

        await tx.insert(seatOccupancies).values({
          companyId,
          seatId,
          occupantType: "agent",
          occupantId: agentId,
          occupancyRole: "shadow_agent",
          status: "active",
          startsAt: now,
          createdAt: now,
          updatedAt: now,
        });

        const nextMode = await resolveOperatingMode(companyId, seatId, tx);
        operatingMode = nextMode;
        await tx
          .update(seats)
          .set({
            operatingMode: nextMode,
            updatedAt: now,
          })
          .where(eq(seats.id, seatId));
      });
      return {
        seatId,
        companyId,
        previousOperatingMode,
        operatingMode,
        currentHumanUserId,
        fallbackReassignedIssueCount: 0,
      };
    },

    reassignPrimaryAgent: async (companyId: string, seatId: string, agentId: string): Promise<SeatMutationResult> => {
      const now = new Date();
      let previousOperatingMode: string | null = null;
      let currentHumanUserId: string | null = null;
      let operatingMode = "vacant";

      await db.transaction(async (tx) => {
        const seat = await lockSeatForMutation(tx, companyId, seatId);
        if (!seat || seat.companyId !== companyId) throw notFound("Seat not found");
        assertSeatIsActive(seat);
        previousOperatingMode = seat.operatingMode;
        currentHumanUserId = seat.currentHumanUserId ?? null;
        await getAgentForSeatMutation(companyId, agentId, tx);

        await tx
          .update(seatOccupancies)
          .set({ status: "inactive", endsAt: now, updatedAt: now })
          .where(
            and(
              eq(seatOccupancies.companyId, companyId),
              eq(seatOccupancies.seatId, seatId),
              eq(seatOccupancies.occupancyRole, "primary_agent"),
              eq(seatOccupancies.status, "active"),
            ),
          );

        await tx.insert(seatOccupancies).values({
          companyId,
          seatId,
          occupantType: "agent",
          occupantId: agentId,
          occupancyRole: "primary_agent",
          status: "active",
          startsAt: now,
          createdAt: now,
          updatedAt: now,
          metadata: { source: "seat_primary_reassignment" },
        });

        await tx
          .update(agents)
          .set({
            seatRole: null,
            updatedAt: now,
          })
          .where(and(eq(agents.companyId, companyId), eq(agents.seatId, seatId), eq(agents.seatRole, "primary_agent")));

        await tx
          .update(agents)
          .set({
            seatId,
            seatRole: "primary_agent",
            updatedAt: now,
          })
          .where(eq(agents.id, agentId));

        operatingMode = await resolveOperatingMode(companyId, seatId, tx);
        await tx
          .update(seats)
          .set({
            operatingMode,
            updatedAt: now,
          })
          .where(eq(seats.id, seatId));
      });
      return {
        seatId,
        companyId,
        previousOperatingMode,
        operatingMode,
        currentHumanUserId,
        fallbackReassignedIssueCount: 0,
      };
    },

    detachShadowAgent: async (companyId: string, seatId: string, agentId?: string | null): Promise<SeatMutationResult> => {
      const now = new Date();
      let previousOperatingMode: string | null = null;
      let currentHumanUserId: string | null = null;
      let operatingMode = "vacant";
      await db.transaction(async (tx) => {
        const seat = await lockSeatForMutation(tx, companyId, seatId);
        if (!seat || seat.companyId !== companyId) throw notFound("Seat not found");
        previousOperatingMode = seat.operatingMode;
        currentHumanUserId = seat.currentHumanUserId ?? null;
        const conditions = [
          eq(seatOccupancies.companyId, companyId),
          eq(seatOccupancies.seatId, seatId),
          eq(seatOccupancies.occupancyRole, "shadow_agent"),
          eq(seatOccupancies.status, "active"),
        ];
        if (agentId) {
          conditions.push(eq(seatOccupancies.occupantType, "agent"));
          conditions.push(eq(seatOccupancies.occupantId, agentId));
        }
        await tx
          .update(seatOccupancies)
          .set({ status: "inactive", endsAt: now, updatedAt: now })
          .where(and(...conditions));

        operatingMode = await resolveOperatingMode(companyId, seatId, tx);
        await tx
          .update(seats)
          .set({
            operatingMode,
            updatedAt: now,
          })
          .where(eq(seats.id, seatId));
      });
      return {
        seatId,
        companyId,
        previousOperatingMode,
        operatingMode,
        currentHumanUserId,
        fallbackReassignedIssueCount: 0,
      };
    },

    attachHuman: async (companyId: string, seatId: string, userId: string): Promise<SeatMutationResult> => {
      const now = new Date();
      let previousOperatingMode: string | null = null;
      let operatingMode = "vacant";
      await db.transaction(async (tx) => {
        const seat = await lockSeatForMutation(tx, companyId, seatId);
        if (!seat || seat.companyId !== companyId) throw notFound("Seat not found");
        assertSeatIsActive(seat);
        previousOperatingMode = seat.operatingMode;
        const membership = await assertActiveUserMembership(companyId, userId, tx);
        if (!membership) throw conflict("User must have active company membership");
        const existingActive = await tx
          .select({ id: seatOccupancies.id })
          .from(seatOccupancies)
          .where(
            and(
              eq(seatOccupancies.companyId, companyId),
              eq(seatOccupancies.seatId, seatId),
              eq(seatOccupancies.occupancyRole, "human_operator"),
              eq(seatOccupancies.status, "active"),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existingActive) {
          await tx
            .update(seatOccupancies)
            .set({ status: "inactive", endsAt: now, updatedAt: now })
            .where(eq(seatOccupancies.id, existingActive.id));
        }

        await tx.insert(seatOccupancies).values({
          companyId,
          seatId,
          occupantType: "user",
          occupantId: userId,
          occupancyRole: "human_operator",
          status: "active",
          startsAt: now,
          createdAt: now,
          updatedAt: now,
        });
        operatingMode = await resolveOperatingMode(companyId, seatId, tx);
        await tx
          .update(seats)
          .set({
            currentHumanUserId: userId,
            operatingMode,
            updatedAt: now,
          })
          .where(eq(seats.id, seatId));
      });

      return {
        seatId,
        companyId,
        previousOperatingMode,
        operatingMode,
        currentHumanUserId: userId,
        fallbackReassignedIssueCount: 0,
      };
    },

    detachHuman: async (companyId: string, seatId: string, userId?: string | null): Promise<SeatMutationResult> => {
      const now = new Date();

      let fallbackReassignedIssueCount = 0;
      let previousOperatingMode: string | null = null;
      let operatingMode = "vacant";

      await db.transaction(async (tx) => {
        const seat = await lockSeatForMutation(tx, companyId, seatId);
        if (!seat || seat.companyId !== companyId) throw notFound("Seat not found");
        previousOperatingMode = seat.operatingMode;
        const detachedUserId = userId ?? seat.currentHumanUserId ?? null;
        if (detachedUserId) {
          await tx
            .update(seatOccupancies)
            .set({ status: "inactive", endsAt: now, updatedAt: now })
            .where(
              and(
                eq(seatOccupancies.companyId, companyId),
                eq(seatOccupancies.seatId, seatId),
                eq(seatOccupancies.occupancyRole, "human_operator"),
                eq(seatOccupancies.occupantType, "user"),
                eq(seatOccupancies.occupantId, detachedUserId),
                eq(seatOccupancies.status, "active"),
              ),
            );
        }

        await tx
          .update(seatOccupancies)
          .set({ status: "inactive", endsAt: now, updatedAt: now })
          .where(
            and(
              eq(seatOccupancies.companyId, companyId),
              eq(seatOccupancies.seatId, seatId),
              eq(seatOccupancies.occupancyRole, "shadow_agent"),
              eq(seatOccupancies.status, "active"),
            ),
          );

        if (detachedUserId && seat.defaultAgentId) {
          const openHumanOwnedIssues = await tx
            .select({
              id: issues.id,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              checkoutRunId: issues.checkoutRunId,
              executionRunId: issues.executionRunId,
              executionLockedAt: issues.executionLockedAt,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                eq(issues.ownerSeatId, seatId),
                eq(issues.assigneeUserId, detachedUserId),
                isNull(issues.hiddenAt),
                inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
              ),
            );

          for (const issue of openHumanOwnedIssues) {
            const nextAssigneeAgentId = issue.assigneeAgentId ?? seat.defaultAgentId;
            await tx
              .update(issues)
              .set({
                assigneeAgentId: nextAssigneeAgentId,
                assigneeUserId: null,
                checkoutRunId: issue.assigneeAgentId ? issue.checkoutRunId : null,
                executionRunId: issue.assigneeAgentId ? issue.executionRunId : null,
                executionLockedAt: issue.assigneeAgentId ? issue.executionLockedAt : null,
                status: issue.assigneeAgentId
                  ? issue.status
                  : issue.status === "in_progress"
                    ? "todo"
                    : issue.status,
                updatedAt: now,
              })
              .where(eq(issues.id, issue.id));
          }
          fallbackReassignedIssueCount = openHumanOwnedIssues.length;
        }
        operatingMode = await resolveOperatingMode(companyId, seatId, tx);
        await tx
          .update(seats)
          .set({
            currentHumanUserId: null,
            operatingMode,
            updatedAt: now,
          })
          .where(eq(seats.id, seatId));
      });

      return {
        seatId,
        companyId,
        previousOperatingMode,
        operatingMode,
        currentHumanUserId: null,
        fallbackReassignedIssueCount,
      };
    },
  };
}
