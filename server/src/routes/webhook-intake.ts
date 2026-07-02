import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { ISSUE_PRIORITIES, requiredWorkProductTypeSchema } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";
import { unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export const WEBHOOK_INTAKE_ORIGIN_KIND = "webhook_intake";

const mappedPayloadSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  sourceRef: z.string().trim().min(1).max(2000).nullable(),
  requiredWorkProductType: requiredWorkProductTypeSchema.optional(),
  maxCostCents: z.number().int().positive().optional(),
});

// Accepts either a GitHub issue webhook payload or a generic
// {title, body?, priority?, sourceRef?, requiredWorkProductType?, maxCostCents?} shape.
export function mapIntakePayload(body: unknown): z.infer<typeof mappedPayloadSchema> {
  const record = (body ?? {}) as Record<string, unknown>;
  const gh = record.issue as Record<string, unknown> | undefined;
  const raw = gh && typeof gh.title === "string"
    ? {
      title: gh.title,
      description: typeof gh.body === "string" && gh.body.length > 0 ? gh.body : null,
      sourceRef: typeof gh.html_url === "string" ? gh.html_url : null,
      // GitHub issues resolve to code; require a PR by default.
      requiredWorkProductType: "pull_request" as const,
    }
    : {
      title: record.title,
      description: typeof record.body === "string" && record.body.length > 0 ? record.body : null,
      priority: record.priority,
      sourceRef: typeof record.sourceRef === "string" ? record.sourceRef : null,
      requiredWorkProductType: record.requiredWorkProductType,
      maxCostCents: record.maxCostCents,
    };
  const parsed = mappedPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw unprocessable("Intake payload must be a GitHub issue webhook or {title, body?, priority?, sourceRef?}");
  }
  return parsed.data;
}

export function webhookIntakeRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);

  router.post("/webhooks/intake/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const payload = mapIntakePayload(req.body);

    const findExisting = () =>
      db
        .select({ id: issues.id, identifier: issues.identifier, status: issues.status })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, WEBHOOK_INTAKE_ORIGIN_KIND),
            eq(issues.originId, payload.sourceRef as string),
            isNull(issues.hiddenAt),
          ),
        )
        .then((rows) => rows[0] ?? null);

    if (payload.sourceRef) {
      const existing = await findExisting();
      if (existing) {
        res.json({ issue: existing, deduplicated: true });
        return;
      }
    }

    const actor = getActorInfo(req);
    let issue;
    try {
      issue = await svc.create(companyId, {
        title: payload.title,
        description: payload.description,
        priority: payload.priority ?? "medium",
        status: "backlog",
        originKind: WEBHOOK_INTAKE_ORIGIN_KIND,
        originId: payload.sourceRef,
        requiredWorkProductType: payload.requiredWorkProductType ?? null,
        maxCostCents: payload.maxCostCents ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
    } catch (err) {
      // Concurrent redelivery lost the unique-index race; return the winner.
      if (payload.sourceRef && (err as { code?: string })?.code === "23505") {
        const existing = await findExisting();
        if (existing) {
          res.json({ issue: existing, deduplicated: true });
          return;
        }
      }
      throw err;
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        originKind: WEBHOOK_INTAKE_ORIGIN_KIND,
        sourceRef: payload.sourceRef,
      },
    });

    res.status(201).json({ issue: { id: issue.id, identifier: issue.identifier, status: issue.status }, deduplicated: false });
  });

  return router;
}
