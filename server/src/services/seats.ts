import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, backfillSeatModel, companyMemberships, issues, seatOccupancies, seats } from "@paperclipai/db";

type SeatRow = typeof seats.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

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
  operatingMode: string;
  currentHumanUserId: string | null;
  delegatedPermissions: string[];
  defaultAgentId: string | null;
}

function mapSeatStatus(seat: SeatRow, displayAgent: AgentRow | null): string {
  if (seat.status === "paused") return "paused";
  if (seat.status === "archived") return "terminated";
  return displayAgent?.status ?? "active";
}

export function seatService(db: Db) {
  function delegatedPermissionsFromMetadata(metadata: Record<string, unknown> | null | undefined): string[] {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
    const values = metadata["delegatedPermissions"];
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is string => typeof value === "string");
  }

  async function getById(seatId: string) {
    return db
      .select()
      .from(seats)
      .where(eq(seats.id, seatId))
      .then((rows) => rows[0] ?? null);
  }

  async function getDetail(companyId: string, seatId: string): Promise<SeatDetail | null> {
    const seat = await getById(seatId);
    if (!seat || seat.companyId !== companyId) return null;
    return {
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
    };
  }

  async function resolveOperatingMode(companyId: string, seatId: string, executor: Db = db): Promise<string> {
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

  async function assertActiveUserMembership(companyId: string, userId: string) {
    const membership = await db
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
      const seatRows = await db
        .select()
        .from(seats)
        .where(eq(seats.companyId, companyId));

      let updatedSeatCount = 0;
      for (const seat of seatRows) {
        const nextMode = await resolveOperatingMode(companyId, seat.id, db);
        if (seat.operatingMode !== nextMode) {
          await db
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
    },

    updateDelegatedPermissions: async (
      companyId: string,
      seatId: string,
      delegatedPermissions: string[],
    ): Promise<SeatDetail | null> => {
      const seat = await getById(seatId);
      if (!seat || seat.companyId !== companyId) return null;
      const metadata =
        seat.metadata && typeof seat.metadata === "object" && !Array.isArray(seat.metadata)
          ? { ...(seat.metadata as Record<string, unknown>) }
          : {};
      metadata.delegatedPermissions = delegatedPermissions;
      await db
        .update(seats)
        .set({
          metadata,
          updatedAt: new Date(),
        })
        .where(eq(seats.id, seatId));
      return getDetail(companyId, seatId);
    },

    attachShadowAgent: async (companyId: string, seatId: string, agentId: string): Promise<SeatMutationResult> => {
      const seat = await getById(seatId);
      if (!seat || seat.companyId !== companyId) throw new Error("Seat not found");
      const now = new Date();

      await db.transaction(async (tx) => {
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

        const nextMode = await resolveOperatingMode(companyId, seatId, tx as unknown as Db);
        await tx
          .update(seats)
          .set({
            operatingMode: nextMode,
            updatedAt: now,
          })
          .where(eq(seats.id, seatId));
      });

      const updatedSeat = await getById(seatId);
      return {
        seatId,
        companyId,
        operatingMode: updatedSeat?.operatingMode ?? "shadowed",
        currentHumanUserId: updatedSeat?.currentHumanUserId ?? null,
        fallbackReassignedIssueCount: 0,
      };
    },

    attachHuman: async (companyId: string, seatId: string, userId: string): Promise<SeatMutationResult> => {
      const seat = await getById(seatId);
      if (!seat || seat.companyId !== companyId) throw new Error("Seat not found");
      const membership = await assertActiveUserMembership(companyId, userId);
      if (!membership) throw new Error("User must have active company membership");

      const now = new Date();
      let operatingMode = "vacant";
      await db.transaction(async (tx) => {
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
        operatingMode = await resolveOperatingMode(companyId, seatId, tx as unknown as Db);
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
        operatingMode,
        currentHumanUserId: userId,
        fallbackReassignedIssueCount: 0,
      };
    },

    detachHuman: async (companyId: string, seatId: string, userId?: string | null): Promise<SeatMutationResult> => {
      const seat = await getById(seatId);
      if (!seat || seat.companyId !== companyId) throw new Error("Seat not found");
      const now = new Date();
      const detachedUserId = userId ?? seat.currentHumanUserId ?? null;

      let fallbackReassignedIssueCount = 0;
      let operatingMode = "vacant";

      await db.transaction(async (tx) => {
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
            .select({ id: issues.id, status: issues.status })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                eq(issues.ownerSeatId, seatId),
                eq(issues.assigneeUserId, detachedUserId),
                isNull(issues.assigneeAgentId),
                isNull(issues.hiddenAt),
                inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
              ),
            );

          for (const issue of openHumanOwnedIssues) {
            await tx
              .update(issues)
              .set({
                assigneeAgentId: seat.defaultAgentId,
                assigneeUserId: null,
                checkoutRunId: null,
                executionRunId: null,
                executionLockedAt: null,
                status: issue.status === "in_progress" ? "todo" : issue.status,
                updatedAt: now,
              })
              .where(eq(issues.id, issue.id));
          }
          fallbackReassignedIssueCount = openHumanOwnedIssues.length;
        }
        operatingMode = await resolveOperatingMode(companyId, seatId, tx as unknown as Db);
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
        operatingMode,
        currentHumanUserId: null,
        fallbackReassignedIssueCount,
      };
    },
  };
}
