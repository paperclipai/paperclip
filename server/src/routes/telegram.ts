/**
 * Telegram ingest route.
 *
 * Receives messages forwarded from the telegram-bot sidecar and creates
 * Paperclip issues or posts comments, depending on the message content.
 *
 * POST /api/telegram/ingest
 *   body: { chat_id, text, message_id?, username? }
 *
 * Message parsing rules:
 *   /issue <title>          → create issue (explicit)
 *   /comment <id> <text>    → post comment on issue by identifier (e.g. ANGA-42)
 *   any other text          → create issue with title = first line, rest = description
 *
 * Default project: TELEGRAM_DEFAULT_PROJECT_ID env var (optional).
 * Default company: TELEGRAM_DEFAULT_COMPANY_ID env var, falls back to first company.
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issueService, heartbeatService } from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_COMPANY_ID =
  process.env.TELEGRAM_DEFAULT_COMPANY_ID ?? "dbc742c7-9a38-4542-936b-523dfa3a7fd2";
const DEFAULT_PROJECT_ID = process.env.TELEGRAM_DEFAULT_PROJECT_ID ?? null;
// Issues created from Telegram are automatically assigned to the CTO for triage.
const TELEGRAM_ASSIGNEE_AGENT_ID =
  process.env.TELEGRAM_ASSIGNEE_AGENT_ID ?? "4e5cbf52-a530-439f-917c-a6cfee78d76d";

interface IngestBody {
  chat_id: number;
  text: string;
  message_id?: number;
  username?: string;
}

export function telegramRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);
  const heartbeat = heartbeatService(db);

  router.post("/telegram/ingest", async (req, res) => {
    const body = req.body as IngestBody;

    if (!body?.text || typeof body.text !== "string") {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const text = body.text.trim();
    const from = body.username ? `@${body.username}` : `chat_id:${body.chat_id}`;

    try {
      // /comment <ANGA-NNN> <message text>
      const commentMatch = text.match(/^\/comment\s+([A-Z]+-\d+)\s+([\s\S]+)$/i);
      if (commentMatch) {
        const identifier = commentMatch[1].toUpperCase();
        const commentBody = commentMatch[2].trim();

        const issue = await svc.getByIdentifier(identifier);
        if (!issue) {
          res.status(404).json({ error: `Issue ${identifier} not found` });
          return;
        }

        const comment = await svc.addComment(
          issue.id,
          `📱 ${from}: ${commentBody}`,
          { userId: "telegram" },
        );

        logger.info({ identifier, commentId: comment.id }, "telegram-ingest: comment posted");
        res.json({ ok: true, action: "comment", identifier, commentId: comment.id });
        return;
      }

      // /issue <title> or free text → create issue
      let title: string;
      let description: string | null = null;

      const issueMatch = text.match(/^\/issue\s+([\s\S]+)$/i);
      if (issueMatch) {
        const content = issueMatch[1].trim();
        const lines = content.split("\n");
        title = lines[0].trim();
        description = lines.length > 1 ? lines.slice(1).join("\n").trim() : null;
      } else {
        const lines = text.split("\n");
        title = lines[0].trim();
        description =
          lines.length > 1
            ? `_From Telegram (${from})_\n\n${lines.slice(1).join("\n").trim()}`
            : `_From Telegram (${from})_`;
      }

      const issue = await svc.create(DEFAULT_COMPANY_ID, {
        title,
        description,
        status: "todo",
        priority: "medium",
        projectId: DEFAULT_PROJECT_ID,
        createdByUserId: "telegram",
        createdByAgentId: null,
        assigneeAgentId: TELEGRAM_ASSIGNEE_AGENT_ID,
      });

      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "telegram.ingest",
        requestedByActorType: "system",
        requestedByActorId: null,
      });

      logger.info(
        { identifier: issue.identifier, title, assigneeAgentId: TELEGRAM_ASSIGNEE_AGENT_ID },
        "telegram-ingest: issue created",
      );
      res.json({ ok: true, action: "issue", identifier: issue.identifier, issueId: issue.id });
    } catch (err) {
      logger.error({ err }, "telegram-ingest: error");
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
