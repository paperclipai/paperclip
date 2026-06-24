import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { createMailAddressSchema, mailInboxQuerySchema, sendEmailSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentService, mailAddressService, mailMessageService, logActivity } from "../services/index.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { MailAddressActor } from "../services/mail-addresses.js";

/**
 * Agent-facing email (embedded mail, phase 1): an agent manages its own
 * addresses and reads its inbox. Board members can also act for an agent.
 */
export function agentEmailRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const addresses = mailAddressService(db);
  const messages = mailMessageService(db);

  async function resolveContext(
    req: Request,
    agentId: string,
  ): Promise<{ companyId: string; actor: MailAddressActor }> {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    const info = getActorInfo(req);
    if (info.actorType === "agent" && info.agentId !== agentId) {
      throw forbidden("Agents can only access their own mailbox");
    }
    return { companyId: agent.companyId, actor: { actorType: info.actorType, actorId: info.actorId } };
  }

  // List the agent's addresses.
  router.get("/agents/:agentId/email/addresses", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await addresses.list(companyId, { agentId }));
  });

  // Create an address for the agent.
  router.post("/agents/:agentId/email/addresses", validate(createMailAddressSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const address = await addresses.create(companyId, agentId, req.body, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_address_created",
      entityType: "mail_address",
      entityId: address.id,
      agentId,
      details: { address: address.address, kind: address.kind },
    });
    res.status(201).json(address);
  });

  // Delete an address.
  router.delete("/agents/:agentId/email/addresses/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const address = await addresses.getById(companyId, id);
    if (address.agentId !== agentId) throw forbidden("This address does not belong to the agent");
    await addresses.remove(companyId, id);
    res.status(204).end();
  });

  // Read the agent's inbox.
  router.get("/agents/:agentId/email/inbox", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    const parsed = mailInboxQuerySchema.safeParse(req.query);
    if (!parsed.success) throw unprocessable("Invalid inbox query");
    res.json(await messages.listInbox(companyId, agentId, parsed.data));
  });

  // Fetch one message.
  router.get("/agents/:agentId/email/messages/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    res.json(message);
  });

  // Send (or reply to) an email from one of the agent's addresses.
  router.post("/agents/:agentId/email/send", validate(sendEmailSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    const from = await addresses.getById(companyId, req.body.fromAddressId);
    if (from.agentId !== agentId) throw forbidden("That address does not belong to the agent");
    if (from.status !== "active") throw unprocessable("That address is not active");
    const queued = await messages.enqueueOutbound(companyId, {
      addressId: from.id,
      agentId,
      fromAddr: from.address,
      toAddrs: req.body.to,
      ccAddrs: req.body.cc ?? [],
      subject: req.body.subject ?? null,
      textBody: req.body.text ?? null,
      htmlBody: req.body.html ?? null,
      inReplyTo: req.body.inReplyTo ?? null,
    });
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      action: "email_sent",
      entityType: "mail_message",
      entityId: queued.id,
      agentId,
      details: { from: from.address, to: req.body.to, subject: req.body.subject ?? null },
    });
    res.status(202).json(queued);
  });

  // Mark a message read.
  router.post("/agents/:agentId/email/messages/:id/read", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    res.json(await messages.markRead(companyId, id));
  });

  return router;
}
