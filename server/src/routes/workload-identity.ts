import { Router, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { workloadIdentityService } from "../services/workload-identity.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const companyIdSchema = z.string().uuid();

function notPublished(res: Response) {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.status(404).json({ error: "not_found" });
}

/**
 * Public OIDC discovery and key set for a company's workload identity issuer.
 * Outside clouds fetch these anonymously to verify tokens; they expose only
 * public keys, and answer 404 until the company has created a key.
 */
export function workloadIdentityPublicRoutes(db: Db) {
  const router = Router();
  const service = workloadIdentityService(db);
  router.get("/oidc/companies/:companyId/.well-known/openid-configuration", async (req, res) => {
    const companyId = companyIdSchema.safeParse(req.params.companyId);
    if (!companyId.success) return notPublished(res);
    const document = await service.discoveryDocument(companyId.data);
    if (!document) return notPublished(res);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(document);
  });
  router.get("/oidc/companies/:companyId/jwks.json", async (req, res) => {
    const companyId = companyIdSchema.safeParse(req.params.companyId);
    if (!companyId.success) return notPublished(res);
    const keySet = await service.publicKeySet(companyId.data);
    if (!keySet) return notPublished(res);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(keySet);
  });
  return router;
}

const rotationSchema = z.object({ step: z.enum(["begin", "complete", "emergency"]) }).strict();

/** Board-only status and key rotation for the company's issuer. */
export function workloadIdentityRoutes(db: Db) {
  const router = Router();
  const service = workloadIdentityService(db);
  router.get("/companies/:companyId/workload-identity", async (req, res) => {
    assertBoard(req);
    const companyId = companyIdSchema.parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json(await service.describe(companyId));
  });
  router.post("/companies/:companyId/workload-identity/rotation", validate(rotationSchema), async (req, res) => {
    assertBoard(req);
    const companyId = companyIdSchema.parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const { step } = req.body as z.infer<typeof rotationSchema>;
    const { actorType, actorId } = getActorInfo(req);
    // The service writes the activity entry in the same transaction as the key change.
    const actor = { actorType, actorId };
    const result = step === "begin"
      ? await service.beginRotation(companyId, actor)
      : step === "complete"
        ? await service.completeRotation(companyId, actor)
        : await service.emergencyRotation(companyId, actor);
    res.json({ step, ...result, state: await service.describe(companyId) });
  });
  return router;
}
