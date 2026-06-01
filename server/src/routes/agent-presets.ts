import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agentPresetService, agentService, logActivity } from "../services/index.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const presetEntrySchema = z.object({
  agentNameKey: z.string().min(1).max(120).optional(),
  agentName: z.string().max(200).optional(),
  adapterType: z.string().min(1).max(80),
  adapterConfig: z.record(z.unknown()).optional(),
});

const createPresetSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  snapshot: z.array(presetEntrySchema).max(500).optional(),
});

export function agentPresetRoutes(db: Db) {
  const router = Router();
  const presets = agentPresetService(db);
  const agents = agentService(db);

  async function assertCanManagePresets(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      return;
    }
    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    const actor = await agents.getById(req.actor.agentId);
    if (!actor || actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actor.role !== "ceo") {
      throw forbidden("Only CEO agents can manage agent presets");
    }
  }

  router.get(
    "/companies/:companyId/agent-presets",
    async (req, res, next) => {
      try {
        assertCompanyAccess(req, (req.params.companyId as string));
        const items = await presets.list((req.params.companyId as string));
        res.json({ items });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/companies/:companyId/agent-presets",
    validate(createPresetSchema),
    async (req, res, next) => {
      try {
        await assertCanManagePresets(req, (req.params.companyId as string));
        const actor = getActorInfo(req);
        const created = await presets.create((req.params.companyId as string), {
          name: req.body.name,
          description: req.body.description ?? null,
          snapshot: req.body.snapshot,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        });
        await logActivity(db, {
          companyId: (req.params.companyId as string),
          actorType: actor.actorType === "agent" ? "agent" : "user",
          actorId: actor.actorId,
          action: "agent_preset_saved",
          entityType: "agent_preset",
          entityId: created.id,
          agentId: actor.agentId,
          details: { name: created.name, snapshotCount: created.snapshot.length },
        });
        res.status(201).json({ preset: created });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/companies/:companyId/agent-presets/:id",
    async (req, res, next) => {
      try {
        assertCompanyAccess(req, (req.params.companyId as string));
        const preset = await presets.getById((req.params.companyId as string), (req.params.id as string));
        if (!preset) throw notFound("Preset not found");
        res.json({ preset });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/companies/:companyId/agent-presets/:id/apply",
    async (req, res, next) => {
      try {
        await assertCanManagePresets(req, (req.params.companyId as string));
        const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";
        const result = await presets.apply((req.params.companyId as string), (req.params.id as string), { dryRun });
        if (!dryRun) {
          const actor = getActorInfo(req);
          await logActivity(db, {
            companyId: (req.params.companyId as string),
            actorType: actor.actorType === "agent" ? "agent" : "user",
            actorId: actor.actorId,
            action: "agent_preset_applied",
            entityType: "agent_preset",
            entityId: (req.params.id as string),
            agentId: actor.agentId,
            details: {
              applied: result.appliedAgentIds.length,
              unmatched: result.unmatched.length,
              total: result.total,
            },
          });
        }
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/companies/:companyId/agent-presets/:id",
    async (req, res, next) => {
      try {
        await assertCanManagePresets(req, (req.params.companyId as string));
        const deleted = await presets.remove((req.params.companyId as string), (req.params.id as string));
        if (!deleted) throw notFound("Preset not found");
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: (req.params.companyId as string),
          actorType: actor.actorType === "agent" ? "agent" : "user",
          actorId: actor.actorId,
          action: "agent_preset_deleted",
          entityType: "agent_preset",
          entityId: deleted.id,
          agentId: actor.agentId,
          details: { name: deleted.name },
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // Silence unused-import warning for badRequest if not directly used; keeps it
  // available for future validation expansion without refactor noise.
  void badRequest;

  return router;
}
