import { and, eq, isNull, ne } from "drizzle-orm";
import { autonomyIncidents } from "@paperclipai/db";
import type { AutonomyIncident, AutonomyIncidentType, AutonomySourceType } from "@paperclipai/shared";
import type { AutonomyKernelContext, CreateIncidentInput, ResolveIncidentInput } from "./types.js";

export class AutonomyIncidentError extends Error {
  constructor(
    message: string,
    public readonly code: "INCIDENT_NOT_FOUND",
  ) {
    super(message);
    this.name = "AutonomyIncidentError";
  }
}

type IncidentRow = typeof autonomyIncidents.$inferSelect;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIncidentDto(row: IncidentRow): AutonomyIncident {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as AutonomyIncidentType,
    severity: row.severity as AutonomyIncident["severity"],
    status: row.status as AutonomyIncident["status"],
    laneKey: row.laneKey ?? null,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    agentId: row.agentId ?? null,
    sourceType: row.sourceType as AutonomySourceType,
    sourceId: row.sourceId ?? null,
    title: row.title,
    message: row.message,
    remediation: row.remediation ?? null,
    stopsLane: row.stopsLane,
    metadata: (row.metadata as AutonomyIncident["metadata"]) ?? null,
    acknowledgedByUserId: row.acknowledgedByUserId ?? null,
    acknowledgedAt: toIso(row.acknowledgedAt),
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedAt: toIso(row.resolvedAt),
    resolutionNote: row.resolutionNote ?? null,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function createIncidentService(context: AutonomyKernelContext) {
  const { db } = context;

  return {
    async createIncident(input: CreateIncidentInput): Promise<AutonomyIncident> {
      const sourceType = input.sourceType ?? "kernel";
      const sourceId = input.sourceId ?? null;
      const idempotencyKey = input.idempotencyKey ?? null;

      if (input.idempotent || idempotencyKey) {
        const sourceIdPredicate = sourceId === null ? isNull(autonomyIncidents.sourceId) : eq(autonomyIncidents.sourceId, sourceId);
        const existing = await db
          .select()
          .from(autonomyIncidents)
          .where(
            idempotencyKey
              ? and(
                  eq(autonomyIncidents.companyId, input.companyId),
                  eq(autonomyIncidents.idempotencyKey, idempotencyKey),
                  ne(autonomyIncidents.status, "resolved"),
                )
              : and(
                  eq(autonomyIncidents.companyId, input.companyId),
                  eq(autonomyIncidents.type, input.type),
                  eq(autonomyIncidents.sourceType, sourceType),
                  sourceIdPredicate,
                  ne(autonomyIncidents.status, "resolved"),
                ),
          )
          .limit(1);

        if (existing[0]) {
          return toIncidentDto(existing[0]);
        }
      }

      const now = new Date();
      const [created] = await db
        .insert(autonomyIncidents)
        .values({
          companyId: input.companyId,
          type: input.type,
          severity: input.severity,
          status: input.status ?? "open",
          laneKey: input.laneKey ?? null,
          runId: input.runId ?? null,
          issueId: input.issueId ?? null,
          agentId: input.agentId ?? null,
          sourceType,
          sourceId,
          title: input.title,
          message: input.message,
          remediation: input.remediation ?? null,
          stopsLane: input.stopsLane ?? input.severity === "critical",
          idempotencyKey,
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return toIncidentDto(created);
    },

    async resolveIncident(input: ResolveIncidentInput): Promise<AutonomyIncident> {
      const now = new Date();
      const [updated] = await db
        .update(autonomyIncidents)
        .set({
          status: "resolved",
          resolvedByUserId: input.resolvedByUserId ?? null,
          resolvedAt: now,
          resolutionNote: input.resolutionNote ?? null,
          updatedAt: now,
        })
        .where(and(eq(autonomyIncidents.id, input.incidentId), eq(autonomyIncidents.companyId, input.companyId)))
        .returning();

      if (!updated) {
        throw new AutonomyIncidentError("Incident not found for company", "INCIDENT_NOT_FOUND");
      }

      return toIncidentDto(updated);
    },
  };
}
