/**
 * Plan 3 v2 organisation — guild-skills HTTP routes.
 *
 * Distinct from `companySkillRoutes` (the upstream skill catalog) — these
 * routes serve the per-guild knowledge library workers write into.
 *
 * Path convention (matches the plan's spec, scoped under company for
 * consistency with the rest of the API):
 *
 *   GET    /companies/:companyId/guilds/:guildId/skills?provenance=…
 *   GET    /companies/:companyId/guilds/:guildId/skills/:skillId
 *   POST   /companies/:companyId/guilds/:guildId/skills
 *   POST   /companies/:companyId/guilds/:guildId/skills/:skillId/promote
 *   POST   /companies/:companyId/guilds/:guildId/skills/:skillId/record-use
 *   POST   /companies/:companyId/guilds/:guildId/skills/:skillId/retire
 *
 * All routes require company access. Writes (POST) additionally enforce:
 *   - create: any actor with company write access. Workers (agent kind
 *     'worker') and persistent agents may both write — the schema
 *     guarantees provenance='provisional' regardless of caller.
 *   - promote: any non-agent actor. Promoting a skill to canonical
 *     requires human (or future PM/COO orchestrator) approval; we
 *     refuse promote calls from agent-bearer tokens.
 *   - record-use: any actor. Both workers and humans may report
 *     outcomes; the counts power the future auto-promotion vote in
 *     Plan 3b.
 *   - retire: any non-agent actor. Same rationale as promote: retiring
 *     is an operator decision.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  guildSkillCreateSchema,
  guildSkillListQuerySchema,
  guildSkillRecordUseSchema,
  truncateGuildSkillBody,
} from "@paperclipai/shared";

import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { guildSkillService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function guildSkillRoutes(db: Db) {
  const router = Router();
  const svc = guildSkillService(db);

  function assertNonAgentActor(req: Parameters<typeof assertCompanyAccess>[0]) {
    if (req.actor.type === "agent") {
      throw forbidden(
        "Promote / retire requires operator approval; agent-bearer " +
          "tokens cannot promote or retire skills.",
      );
    }
  }

  router.get(
    "/companies/:companyId/guilds/:guildId/skills",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      const parsed = guildSkillListQuerySchema.parse(req.query);
      const skills = await svc.list(companyId, guildId, parsed);
      res.json(skills);
    },
  );

  router.get(
    "/companies/:companyId/guilds/:guildId/skills/:skillId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      const skill = await svc.get(companyId, guildId, skillId);
      res.json(skill);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills",
    validate(guildSkillCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      // No actor-type gate here: workers + humans can both create
      // provisional skills. The service forces provenance='provisional'
      // on every insert, so a worker cannot mint a canonical skill
      // even if it tries.
      const created = await svc.create(companyId, guildId, req.body);
      // Plan 3 Phase F follow-up: emit the same activity_log action the
      // worker-exit hook emits, so the operator's notifier sees skills
      // created directly via the API (workers can bypass the exit-hook
      // path by POSTing here — observed in ROC-75 during the F5 smoke).
      // Wrapped in try/catch — observability never blocks the response.
      try {
        const guild = await svc.assertGuild(companyId, guildId);
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "guild.worker.skills_ingested",
          entityType: "guild_skill",
          entityId: created.id,
          // Anchor the row on the guild (not the caller) so the
          // operator's "activity for guild X" filter and the
          // notifier's guild_slug field both line up with the
          // worker-exit-hook emission shape.
          agentId: guildId,
          runId: created.createdByRunId ?? null,
          details: {
            source: "direct-post",
            run_id: created.createdByRunId ?? null,
            guild_id: guildId,
            guild_slug: guild.name,
            ingested_count: 1,
            rejected_count: 0,
            // No file involved in the direct-POST path; surface false
            // so consumers can distinguish "no learnings.json" from
            // "didn't go through the file path at all".
            file_missing: false,
            ingested: [
              {
                id: created.id,
                name: created.name,
                body: truncateGuildSkillBody(created.body),
              },
            ],
          },
        });
      } catch (telemetryErr) {
        logger.warn(
          {
            err: telemetryErr,
            companyId,
            guildId,
            skillId: created.id,
          },
          "guild-skills POST: failed to write activity_log(guild.worker.skills_ingested)",
        );
      }
      res.status(201).json(created);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills/:skillId/promote",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      assertNonAgentActor(req);
      const promoted = await svc.promote(companyId, guildId, skillId);
      res.json(promoted);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills/:skillId/record-use",
    validate(guildSkillRecordUseSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      const updated = await svc.recordUse(
        companyId,
        guildId,
        skillId,
        req.body.success,
        req.body.runId,
      );
      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/guilds/:guildId/skills/:skillId/retire",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      assertNonAgentActor(req);
      const retired = await svc.retire(companyId, guildId, skillId);
      res.json(retired);
    },
  );

  return router;
}
