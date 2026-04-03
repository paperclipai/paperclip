import { Router } from "express";
import type { Db } from "@ironworksai/db";
import {
  agents as agentsTable,
  companySubscriptions,
  hiringRequests,
} from "@ironworksai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  EMPLOYMENT_TYPES,
  HIRING_REQUEST_STATUSES,
  PLAN_AGENT_LIMITS,
  type EmploymentType,
  type HiringRequestStatus,
} from "@ironworksai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { assertCanWrite, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity, createAgentWorkspace, createHiringRecord } from "../services/index.js";

export function hiringRoutes(db: Db) {
  const router = Router();

  // ── GET /companies/:companyId/hiring-requests ───────────────────────────────
  router.get("/companies/:companyId/hiring-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const statusFilter = req.query.status as string | undefined;
    const conditions = [eq(hiringRequests.companyId, companyId)];
    if (statusFilter && HIRING_REQUEST_STATUSES.includes(statusFilter as HiringRequestStatus)) {
      conditions.push(eq(hiringRequests.status, statusFilter));
    }

    const rows = await db
      .select()
      .from(hiringRequests)
      .where(and(...conditions))
      .orderBy(desc(hiringRequests.createdAt))
      .limit(200);

    res.json(rows);
  });

  // ── POST /companies/:companyId/hiring-requests ──────────────────────────────
  router.post("/companies/:companyId/hiring-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);

    const {
      role,
      title,
      employmentType,
      department,
      justification,
      projectId,
      contractDurationDays,
      contractBudgetCents,
      onboardingKbPageIds,
      reportsToAgentId,
    } = req.body as Record<string, unknown>;

    if (!role || typeof role !== "string") {
      throw badRequest("role is required");
    }
    if (!title || typeof title !== "string") {
      throw badRequest("title is required");
    }

    const resolvedEmploymentType = (typeof employmentType === "string" && EMPLOYMENT_TYPES.includes(employmentType as EmploymentType))
      ? employmentType as string
      : "full_time";

    const actor = getActorInfo(req);
    const row = await db
      .insert(hiringRequests)
      .values({
        companyId,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        role: role as string,
        title: title as string,
        employmentType: resolvedEmploymentType,
        department: typeof department === "string" ? department : null,
        justification: typeof justification === "string" ? justification : null,
        projectId: typeof projectId === "string" ? projectId : null,
        contractDurationDays: typeof contractDurationDays === "number" ? contractDurationDays : null,
        contractBudgetCents: typeof contractBudgetCents === "number" ? contractBudgetCents : null,
        onboardingKbPageIds: Array.isArray(onboardingKbPageIds) ? onboardingKbPageIds : [],
        reportsToAgentId: typeof reportsToAgentId === "string" ? reportsToAgentId : null,
        status: "draft",
      })
      .returning()
      .then((rows) => rows[0]!);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "hiring_request.created",
      entityType: "hiring_request",
      entityId: row.id,
      details: { role: row.role, title: row.title, employmentType: row.employmentType },
    });

    res.status(201).json(row);
  });

  // ── PATCH /companies/:companyId/hiring-requests/:id ─────────────────────────
  router.patch("/companies/:companyId/hiring-requests/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanWrite(req, companyId, db);

    const existing = await db
      .select()
      .from(hiringRequests)
      .where(and(eq(hiringRequests.id, id), eq(hiringRequests.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("Hiring request not found");
    }
    if (existing.status !== "draft") {
      throw unprocessable("Only draft hiring requests can be edited");
    }

    const {
      role,
      title,
      employmentType,
      department,
      justification,
      projectId,
      contractDurationDays,
      contractBudgetCents,
      onboardingKbPageIds,
      reportsToAgentId,
      status,
    } = req.body as Record<string, unknown>;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof role === "string") updates.role = role;
    if (typeof title === "string") updates.title = title;
    if (typeof employmentType === "string" && EMPLOYMENT_TYPES.includes(employmentType as EmploymentType)) {
      updates.employmentType = employmentType;
    }
    if (typeof department === "string") updates.department = department;
    if (typeof justification === "string") updates.justification = justification;
    if (typeof projectId === "string") updates.projectId = projectId;
    if (typeof contractDurationDays === "number") updates.contractDurationDays = contractDurationDays;
    if (typeof contractBudgetCents === "number") updates.contractBudgetCents = contractBudgetCents;
    if (Array.isArray(onboardingKbPageIds)) updates.onboardingKbPageIds = onboardingKbPageIds;
    if (typeof reportsToAgentId === "string") updates.reportsToAgentId = reportsToAgentId;
    // Allow promoting from draft to pending
    if (typeof status === "string" && status === "pending") updates.status = "pending";

    const updated = await db
      .update(hiringRequests)
      .set(updates)
      .where(and(eq(hiringRequests.id, id), eq(hiringRequests.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);

    res.json(updated);
  });

  // ── POST /companies/:companyId/hiring-requests/:id/fulfill ──────────────────
  router.post("/companies/:companyId/hiring-requests/:id/fulfill", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanWrite(req, companyId, db);

    const existing = await db
      .select()
      .from(hiringRequests)
      .where(and(eq(hiringRequests.id, id), eq(hiringRequests.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("Hiring request not found");
    }
    if (existing.status !== "approved") {
      throw unprocessable("Only approved hiring requests can be fulfilled");
    }

    // Check headcount limits
    const subRow = await db
      .select({ planTier: companySubscriptions.planTier })
      .from(companySubscriptions)
      .where(eq(companySubscriptions.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    const tier = subRow?.planTier ?? "starter";
    const limits = PLAN_AGENT_LIMITS[tier] ?? PLAN_AGENT_LIMITS["starter"]!;
    const empType = existing.employmentType as EmploymentType;

    const [counts] = await db
      .select({
        fte: sql<number>`count(*) filter (where ${agentsTable.employmentType} = 'full_time' and ${agentsTable.status} != 'terminated')`,
        contractor: sql<number>`count(*) filter (where ${agentsTable.employmentType} = 'contractor' and ${agentsTable.status} != 'terminated')`,
      })
      .from(agentsTable)
      .where(eq(agentsTable.companyId, companyId));

    const fteCount = Number(counts?.fte ?? 0);
    const contractorCount = Number(counts?.contractor ?? 0);

    if (empType === "full_time" && limits.fte !== -1 && fteCount >= limits.fte) {
      throw unprocessable(`Full-time agent limit reached (${limits.fte}) for ${tier} plan`);
    }
    if (empType === "contractor" && limits.contractor !== -1 && contractorCount >= limits.contractor) {
      throw unprocessable(`Contractor agent limit reached (${limits.contractor}) for ${tier} plan`);
    }

    const actor = getActorInfo(req);

    // Build contract fields for contractors
    const contractEndAt = existing.contractDurationDays
      ? new Date(Date.now() + existing.contractDurationDays * 86_400_000)
      : null;

    const result = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agentsTable)
        .values({
          companyId,
          name: existing.title,
          role: existing.role,
          title: existing.title,
          employmentType: existing.employmentType,
          department: existing.department,
          hiredByUserId: actor.actorType === "user" ? actor.actorId : null,
          reportsTo: existing.reportsToAgentId,
          onboardingContextIds: existing.onboardingKbPageIds,
          contractEndAt,
          contractEndCondition: empType === "contractor" ? "date" : null,
          contractProjectId: existing.projectId,
          contractBudgetCents: existing.contractBudgetCents,
          status: "idle",
        })
        .returning();

      const [updated] = await tx
        .update(hiringRequests)
        .set({
          status: "fulfilled",
          fulfilledAgentId: agent!.id,
          updatedAt: new Date(),
        })
        .where(eq(hiringRequests.id, id))
        .returning();

      return { agent: agent!, hiringRequest: updated! };
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "hiring_request.fulfilled",
      entityType: "hiring_request",
      entityId: id,
      details: {
        agentId: result.agent.id,
        role: result.agent.role,
        employmentType: result.agent.employmentType,
      },
    });

    // Create agent workspace folders and HR hiring record (best-effort, non-blocking)
    try {
      await createAgentWorkspace(db, result.agent.id, companyId, result.agent.role);
      await createHiringRecord(db, {
        companyId,
        hrAgentId: null,
        hiredAgentId: result.agent.id,
        hiredAgentName: result.agent.name,
        hiredAgentRole: result.agent.role,
        employmentType: result.agent.employmentType ?? "full_time",
        hiredByUserId: actor.actorType === "user" ? actor.actorId : null,
        hiredByAgentId: actor.actorType === "agent" ? actor.actorId : null,
      });
    } catch (err) {
      // Non-fatal: workspace/personnel record creation should not block hiring
      console.error("Failed to create agent workspace or hiring record:", err);
    }

    res.status(201).json(result);
  });

  return router;
}
