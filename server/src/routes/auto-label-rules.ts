import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAutoLabelRuleSchema,
  updateAutoLabelRuleSchema,
  dryRunAutoLabelRuleSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { autoLabelRulesService } from "../services/auto-label-rules.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden } from "../errors.js";

export function autoLabelRuleRoutes(db: Db) {
  const router = Router();
  const svc = autoLabelRulesService(db);
  const instSvc = instanceSettingsService(db);

  /** Guard: check that the autoLabelRulesEngine feature flag is enabled. */
  async function assertFeatureEnabled() {
    const experimental = await instSvc.getExperimental();
    if (!experimental.autoLabelRulesEngine) {
      throw forbidden("Auto-label rules engine is not enabled");
    }
  }

  // ── List rules for a company ──────────────────────────────────────────
  router.get("/companies/:companyId/auto-label-rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertFeatureEnabled();

    const rules = await svc.list(companyId);
    res.json(rules);
  });

  // ── Create a rule ─────────────────────────────────────────────────────
  router.post(
    "/companies/:companyId/auto-label-rules",
    validate(createAutoLabelRuleSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertFeatureEnabled();

      const actor = getActorInfo(req);
      try {
        const rule = await svc.create(companyId, req.body, {
          userId: actor.actorType === "user" ? actor.actorId : undefined,
          agentId: actor.agentId ?? undefined,
        });

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "auto_label_rule.created",
          entityType: "auto_label_rule",
          entityId: rule.id,
          details: { name: rule.name, triggerEvent: rule.triggerEvent, action: rule.action },
        });

        res.status(201).json(rule);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Invalid CEL expression:")) {
          res.status(422).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── Update a rule ─────────────────────────────────────────────────────
  router.patch(
    "/auto-label-rules/:ruleId",
    validate(updateAutoLabelRuleSchema),
    async (req, res) => {
      await assertFeatureEnabled();

      const ruleId = req.params.ruleId as string;
      const existing = await svc.getById(ruleId);
      if (!existing) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      try {
        const updated = await svc.update(ruleId, req.body);
        if (!updated) {
          res.status(404).json({ error: "Rule not found" });
          return;
        }

        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "auto_label_rule.updated",
          entityType: "auto_label_rule",
          entityId: updated.id,
          details: { changedKeys: Object.keys(req.body).sort() },
        });

        res.json(updated);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Invalid CEL expression:")) {
          res.status(422).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── Delete a rule ─────────────────────────────────────────────────────
  router.delete("/auto-label-rules/:ruleId", async (req, res) => {
    await assertFeatureEnabled();

    const ruleId = req.params.ruleId as string;
    const existing = await svc.getById(ruleId);
    if (!existing) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const deleted = await svc.delete(ruleId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "auto_label_rule.deleted",
      entityType: "auto_label_rule",
      entityId: ruleId,
      details: { name: existing.name },
    });

    res.json(deleted);
  });

  // ── Dry-run a rule against an issue ───────────────────────────────────
  router.post(
    "/auto-label-rules/:ruleId/dry-run",
    validate(dryRunAutoLabelRuleSchema),
    async (req, res) => {
      await assertFeatureEnabled();

      const ruleId = req.params.ruleId as string;
      const existing = await svc.getById(ruleId);
      if (!existing) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const result = await svc.dryRun(ruleId, req.body.issueId);
      if ("error" in result) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    },
  );

  // ── List executions for a rule (audit log) ────────────────────────────
  router.get("/auto-label-rules/:ruleId/executions", async (req, res) => {
    await assertFeatureEnabled();

    const ruleId = req.params.ruleId as string;
    const existing = await svc.getById(ruleId);
    if (!existing) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const executions = await svc.listExecutions(ruleId, limit);
    res.json(executions);
  });

  return router;
}
