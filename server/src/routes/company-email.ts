import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyEmailService } from "../services/company-email.js";
import { companyVaultService } from "../services/company-vault.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function companyEmailRoutes(db: Db) {
  const router = Router();
  const email = companyEmailService(db);
  const vault = companyVaultService(db);

  /** Get email settings for a company */
  router.get("/companies/:companyId/email/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const settings = await email.getSettings(companyId);
    // Mask the API key in the response
    if (settings?.agentmailApiKey) {
      const key = settings.agentmailApiKey;
      settings.agentmailApiKey =
        key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
    }
    res.json(settings ?? { enabled: false });
  });

  /** Save email settings */
  router.patch("/companies/:companyId/email/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const { agentmailApiKey, agentmailDisplayName, enabled } = req.body;
    const result = await email.saveSettings(companyId, {
      ...(agentmailApiKey !== undefined ? { agentmailApiKey } : {}),
      ...(agentmailDisplayName !== undefined ? { agentmailDisplayName } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    // Mask key in response
    if (result.agentmailApiKey) {
      const key = result.agentmailApiKey;
      result.agentmailApiKey =
        key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
    }
    res.json(result);
  });

  /** Create a new inbox */
  router.post("/companies/:companyId/email/inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    try {
      const { username, display_name } = req.body ?? {};
      const inbox = await email.createInbox(companyId, { username, display_name });
      res.status(201).json(inbox);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** List inboxes */
  router.get("/companies/:companyId/email/inboxes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      const inboxes = await email.listInboxes(companyId);
      res.json(inboxes);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** List messages */
  router.get("/companies/:companyId/email/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const page_token = req.query.page_token as string | undefined;
      const result = await email.listMessages(companyId, { limit, page_token });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** List threads */
  router.get("/companies/:companyId/email/threads", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const page_token = req.query.page_token as string | undefined;
      const result = await email.listThreads(companyId, { limit, page_token });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Get thread */
  router.get("/companies/:companyId/email/threads/:threadId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const threadId = req.params.threadId as string;
    assertCompanyAccess(req, companyId);

    try {
      const thread = await email.getThread(companyId, threadId);
      res.json(thread);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Send message */
  router.post("/companies/:companyId/email/send", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      let { to, subject, text, html, cc, bcc } = req.body;
      if (!to || !subject) {
        res.status(400).json({ error: "to and subject are required" });
        return;
      }
      // Auto-detect and vault any secrets in email body
      try {
        if (text) {
          const vr = await vault.processComment(companyId, `email-send`, `email-${Date.now()}`, text);
          text = vr.redactedBody;
        }
        if (html) {
          const vr = await vault.processComment(companyId, `email-send`, `email-${Date.now()}`, html);
          html = vr.redactedBody;
        }
      } catch (_) { /* vault failure should not block send */ }
      const result = await email.sendMessage(companyId, { to, subject, text, html, cc, bcc });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Reply to message */
  router.post("/companies/:companyId/email/messages/:messageId/reply", async (req, res) => {
    const companyId = req.params.companyId as string;
    const messageId = req.params.messageId as string;
    assertCompanyAccess(req, companyId);

    try {
      let { text, html } = req.body;
      // Auto-detect and vault any secrets in reply body
      try {
        if (text) {
          const vr = await vault.processComment(companyId, `email-reply`, messageId, text);
          text = vr.redactedBody;
        }
        if (html) {
          const vr = await vault.processComment(companyId, `email-reply`, messageId, html);
          html = vr.redactedBody;
        }
      } catch (_) { /* vault failure should not block reply */ }
      const result = await email.replyToMessage(companyId, messageId, { text, html });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
