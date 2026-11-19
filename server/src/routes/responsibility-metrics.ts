import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  RESPONSIBILITY_PRIMARY_METRIC_REF,
  recordResponsibilityMetricReadingSchema,
  setResponsibilityMetricDisplaySchema,
  setResponsibilityMetricsSchema,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails, issueReadSqlCondition, projectReadSqlCondition } from "../services/authorization.js";
import { accessService, logActivity } from "../services/index.js";
import { responsibilityMetricService } from "../services/responsibility-metrics.js";
import { responsibilityService, type ResponsibilityReadScope } from "../services/responsibilities.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";
import { boardCanManageResponsibilityOwner } from "./responsibilities.js";

const NOT_FOUND = "Responsibility not found";
const RECORDABLE_STATUSES = new Set(["proposed", "active"]);

/**
 * A responsibility's metric set (experimental `enableResponsibilities`): the
 * read its bar module draws, recording readings, and the owner setting or
 * removing supporting metrics. Same access as reading the responsibility.
 */
export function responsibilityMetricRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const svc = responsibilityMetricService(db);
  const responsibilitiesSvc = responsibilityService(db);

  async function readScope(req: Request): Promise<ResponsibilityReadScope> {
    const [issueReadCondition, projectReadCondition] = await Promise.all([
      issueReadSqlCondition(db, req.actor),
      projectReadSqlCondition(db, req.actor),
    ]);
    return { issueReadCondition, projectReadCondition };
  }

  /** The detail route's read rule: company access, board or agent, and agents inside the company-scope boundary. */
  async function loadForRead(req: Request, res: Response) {
    const row = await getAccessibleResource(req, res, responsibilitiesSvc.getById(req.params.id as string), NOT_FOUND);
    if (!row) return null;
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    if (req.actor.type === "agent") {
      const decision = await access.decide({ actor: req.actor, action: "company_scope:read", resource: { type: "company", companyId: row.companyId } });
      if (!decision.allowed) {
        throw forbidden("Responsibilities are outside this agent's authorization boundary", authorizationDeniedDetails(decision));
      }
    }
    return row;
  }

  function assertOwnerOrAdmin(req: Request, row: { companyId: string; ownerUserId: string }) {
    if (!boardCanManageResponsibilityOwner(req, row.companyId, row.ownerUserId)) {
      throw forbidden("Only the person who owns this responsibility, or a company admin, can change its metrics");
    }
  }

  async function log(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "responsibility",
      entityId,
      details,
    });
  }

  router.get("/responsibilities/:id/metrics", async (req, res) => {
    await svc.assertEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    res.json(await svc.read(row, await readScope(req)));
  });

  router.put("/responsibilities/:id/metrics", validate(setResponsibilityMetricsSchema), async (req, res) => {
    await svc.assertEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    assertBoard(req);
    assertOwnerOrAdmin(req, row);
    const actor = getActorInfo(req);
    const definitions = await svc.setChosen(row, req.body, { userId: actor.actorId });
    await log(req, row.companyId, "responsibility.metrics_set", row.id, {
      source: "owner",
      primaryDisplay: req.body.primaryDisplay ?? null,
      metrics: definitions.map((definition) => ({ title: definition.title, display: definition.display, readings: definition.readings.length })),
    });
    res.json(await svc.read(row, await readScope(req)));
  });

  router.patch("/responsibilities/:id/metrics/:metricId", validate(setResponsibilityMetricDisplaySchema), async (req, res) => {
    await svc.assertEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    assertBoard(req);
    assertOwnerOrAdmin(req, row);
    const metricRef = req.params.metricId as string;
    const changed = await svc.setDisplay(row, metricRef, req.body.display, { userId: getActorInfo(req).actorId });
    await log(req, row.companyId, "responsibility.metric_display_changed", row.id, {
      metric: metricRef === RESPONSIBILITY_PRIMARY_METRIC_REF ? RESPONSIBILITY_PRIMARY_METRIC_REF : changed.metricId,
      metricTitle: changed.metricTitle,
      from: changed.from,
      to: changed.to,
    });
    res.json(await svc.read(row, await readScope(req)));
  });

  router.delete("/responsibilities/:id/metrics/:metricId", async (req, res) => {
    await svc.assertEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    assertBoard(req);
    assertOwnerOrAdmin(req, row);
    const metric = await svc.remove(row, req.params.metricId as string);
    await log(req, row.companyId, "responsibility.metric_removed", row.id, { metricId: metric.id, title: metric.title });
    res.json(await svc.read(row, await readScope(req)));
  });

  router.post(
    "/responsibilities/:id/metrics/:metricId/readings",
    validate(recordResponsibilityMetricReadingSchema),
    async (req, res) => {
      await svc.assertEnabled();
      const row = await loadForRead(req, res);
      if (!row) return;
      const scope = await readScope(req);
      const actor = getActorInfo(req);
      if (req.actor.type === "board") {
        assertOwnerOrAdmin(req, row);
      } else {
        // The rule for reporting the bar's reading: the agent working under it.
        if (row.status !== "active") throw forbidden("An agent records readings only on an active responsibility");
        if (!(await responsibilitiesSvc.agentWorksOn(row, actor.actorId, scope))) {
          throw forbidden("Only the agent that runs this responsibility, or an agent assigned a task or routine under it, can record its readings");
        }
      }
      if (!RECORDABLE_STATUSES.has(row.status)) {
        throw unprocessable("Readings are recorded only on a proposed or active responsibility");
      }
      const metricRef = req.params.metricId as string;
      const recorded = await svc.record(
        row,
        metricRef,
        req.body,
        req.actor.type === "agent" ? { type: "agent", agentId: actor.actorId, scope } : { type: "board", userId: actor.actorId },
      );
      const details = {
        metricId: recorded.metricId,
        metric: metricRef === RESPONSIBILITY_PRIMARY_METRIC_REF ? RESPONSIBILITY_PRIMARY_METRIC_REF : recorded.metricId,
        metricTitle: recorded.metricTitle,
        value: recorded.value,
        recordedAt: recorded.recordedAt.toISOString(),
        backdated: req.body.recordedAt !== undefined,
        corrected: recorded.corrected,
      };
      await log(req, row.companyId, "responsibility.metric_reading_recorded", row.id, details);
      if (recorded.updated && String(row.metricCurrent ?? "") !== String(recorded.updated.metricCurrent ?? "")) {
        // The bar's reading changed: the same entry a PATCH of metricCurrent writes.
        await log(req, row.companyId, "responsibility.metric_updated", row.id, {
          metricName: recorded.updated.metricName,
          from: row.metricCurrent === null ? null : Number(row.metricCurrent),
          to: recorded.updated.metricCurrent === null ? null : Number(recorded.updated.metricCurrent),
        });
      }
      res.status(201).json({
        reading: {
          metric: details.metric,
          value: recorded.value,
          recordedAt: details.recordedAt,
          corrected: recorded.corrected,
          /** False when an older reading joined the history without changing the bar's reading. */
          current: !recorded.backfilled,
        },
      });
    },
  );

  return router;
}
