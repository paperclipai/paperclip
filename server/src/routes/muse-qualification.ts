import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden, notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import { agentService } from "../services/agents.js";
import { museRunnerBroker } from "../services/muse-runner-broker.js";

const qualificationIdentity = z.object({ bindingId: z.uuid(), qualificationId: z.uuid() }).strict();
const startQualification = qualificationIdentity.extend({ generation: z.number().int().positive(), expectedRevision: z.number().int().positive() }).strict();

/** Operator-only bounded experiment. The broker owns the durable deadline and fencing. */
export function museQualificationRoutes(db: Db) {
  const router = Router();
  const broker = museRunnerBroker(db);
  const path = "/companies/:companyId/agents/:agentId/muse-binding/qualification";
  async function operator(req: Request) {
    const companyId = z.uuid().parse(req.params.companyId), agentId = z.uuid().parse(req.params.agentId);
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (!req.actor.userId || !["session", "cloud_tenant", "board_key"].includes(req.actor.source ?? "")) {
      throw forbidden("Sign in as an operator to manage a Muse qualification.");
    }
    const agent = await agentService(db).getById(agentId);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
    const decision = await accessService(db).decide({ actor: req.actor, action: "agent_config:update",
      resource: { type: "agent", companyId, agentId }, scope: { requiresChangeGrant: true } });
    if (!decision.allowed) throw forbidden(decision.explanation);
    return { companyId, agentId, operatorId: req.actor.userId };
  }
  router.post(path, async (req, res) => {
    const scope = await operator(req);
    const body = startQualification.parse(req.body ?? {});
    // The caller cannot extend the deadline on retries. The broker reuses the
    // existing qualification ID and its original deadline atomically.
    res.set("Cache-Control", "no-store").status(201).json(await broker.beginQualification({
      ...scope, ...body, expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    }));
  });
  router.get(path, async (req, res) => {
    const { companyId, agentId } = await operator(req);
    const { bindingId, qualificationId } = qualificationIdentity.parse(req.query);
    res.set("Cache-Control", "no-store").json(await broker.readQualificationEvidence(companyId, agentId, bindingId, qualificationId));
  });
  router.delete(path, async (req, res) => {
    const scope = await operator(req);
    const body = qualificationIdentity.parse(req.body ?? {});
    await broker.endQualification({ ...scope, ...body });
    res.set("Cache-Control", "no-store").status(204).end();
  });
  return router;
}
