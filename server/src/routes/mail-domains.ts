import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { attachDomainSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mailDomainService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Mail domains for embedded mail (phase 0). Board-only: a human attaches an
 * existing Cloudflare zone, the platform generates DKIM and publishes the mail
 * DNS records. Domain registration is out of scope for V1.
 */
export function mailDomainRoutes(db: Db) {
  const router = Router();
  const svc = mailDomainService(db);

  // List attached mail domains.
  router.get("/companies/:companyId/mail/domains", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await svc.list(companyId));
  });

  // Attach an existing Cloudflare domain and configure its mail DNS.
  router.post(
    "/companies/:companyId/mail/domains",
    validate(attachDomainSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const info = getActorInfo(req);
      const domain = await svc.attach(companyId, req.body.domain, {
        actorType: info.actorType,
        actorId: info.actorId,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: info.actorId,
        action: "mail_domain_attached",
        entityType: "mail_domain",
        entityId: domain.id,
        details: { domain: domain.domain, status: domain.status },
      });
      res.status(201).json(domain);
    },
  );

  // Re-publish + re-evaluate a domain's DNS records.
  router.post("/companies/:companyId/mail/domains/:id/verify", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await svc.verify(companyId, id));
  });

  // Detach a mail domain.
  router.delete("/companies/:companyId/mail/domains/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const domain = await svc.get(companyId, id);
    await svc.remove(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "mail_domain_detached",
      entityType: "mail_domain",
      entityId: id,
      details: { domain: domain.domain },
    });
    res.status(204).end();
  });

  return router;
}
