import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { attachDomainSchema, createMailAddressSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  mailDomainService,
  mailAddressService,
  mailDiagnosticsService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Mail domains + company-level mail addresses for embedded mail. Board-only: a
 * human attaches an existing Cloudflare zone (phase 0) and manages the mailboxes
 * on it (phase 1).
 */
export function mailDomainRoutes(db: Db) {
  const router = Router();
  const svc = mailDomainService(db);
  const addressSvc = mailAddressService(db);

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
    const domain = await svc.verify(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "mail_domain_verified",
      entityType: "mail_domain",
      entityId: domain.id,
      details: { domain: domain.domain, status: domain.status },
    });
    res.json(domain);
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

  // Reverse-DNS (PTR) health for the sending IP. Instance-level infra, surfaced
  // here so a human can see where it stands without running `dig` by hand.
  router.get("/companies/:companyId/mail/reverse-dns", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const force = req.query.refresh === "true";
    res.json(await mailDiagnosticsService().getReverseDnsStatus(force));
  });

  // ─── Mail addresses (company-level management, phase 1) ───────────────────

  // List all mail addresses in the company.
  router.get("/companies/:companyId/mail/addresses", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await addressSvc.list(companyId));
  });

  // Create an address (assign an owning agent, or leave shared / catch-all).
  router.post(
    "/companies/:companyId/mail/addresses",
    validate(createMailAddressSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const info = getActorInfo(req);
      const address = await addressSvc.create(companyId, req.body.agentId ?? null, req.body, {
        actorType: info.actorType,
        actorId: info.actorId,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: info.actorId,
        action: "mail_address_created",
        entityType: "mail_address",
        entityId: address.id,
        agentId: address.agentId,
        details: { address: address.address, kind: address.kind, source: "board" },
      });
      res.status(201).json(address);
    },
  );

  // Delete an address.
  router.delete("/companies/:companyId/mail/addresses/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    await addressSvc.remove(companyId, id);
    res.status(204).end();
  });

  return router;
}
