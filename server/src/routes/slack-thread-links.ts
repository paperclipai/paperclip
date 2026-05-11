import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertAuthenticated } from "./authz.js";
import { slackThreadLinkService, SlackThreadLinkConflictError } from "../services/index.js";

// Slack thread timestamps look like `1234567890.123456` — a unix time in seconds
// followed by a dot and a 6-digit microsecond counter. We accept any non-empty
// string to stay forward-compatible with future Slack id formats, but enforce
// "no whitespace, reasonable length" so a path/body argument can't be exotic.
const slackIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "Must be alphanumeric with . _ -");

const createSchema = z.object({
  threadTs: slackIdSchema,
  channelId: slackIdSchema,
  paperclipResourceType: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "Must be a lowercase identifier"),
  paperclipResourceId: z.string().uuid(),
});

const lookupQuerySchema = z.object({
  channel_id: slackIdSchema.optional(),
});

export function slackThreadLinkRoutes(db: Db) {
  const router = Router();
  const svc = slackThreadLinkService(db);

  router.post("/slack/thread-links", validate(createSchema), async (req, res) => {
    assertAuthenticated(req);
    try {
      const { row, created } = await svc.create(req.body);
      res.status(created ? 201 : 200).json(row);
    } catch (err) {
      if (err instanceof SlackThreadLinkConflictError) {
        throw conflict("Slack thread already linked to a different Paperclip resource", {
          existing: err.existing,
        });
      }
      throw err;
    }
  });

  router.get("/slack/thread-links/:ts", async (req, res) => {
    assertAuthenticated(req);
    const ts = slackIdSchema.parse(req.params.ts);
    const query = lookupQuerySchema.parse(req.query);
    const row = await svc.findByThreadTs(ts, query.channel_id);
    if (!row) {
      throw notFound("Slack thread link not found");
    }
    res.json(row);
  });

  return router;
}
