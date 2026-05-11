import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
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

// Optional `companyId` on the write body. Agents derive their tenant from the
// authenticated actor; board callers (humans, support tooling) MUST supply it
// explicitly and pass `assertCompanyAccess`.
const createSchema = z.object({
  companyId: z.string().uuid().optional(),
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
  company_id: z.string().uuid().optional(),
});

/**
 * Resolve and authorise the tenant for a slack-thread-links request.
 *
 * - agent actor: tenant is fixed by `req.actor.companyId`. Any explicit value
 *   in the body/query must match — silently overriding would let a forged body
 *   smuggle a different tenant if the auth middleware ever loosened.
 * - board actor: `requestedCompanyId` is required, and the actor's company
 *   memberships are checked via `assertCompanyAccess`.
 *
 * `req` already passed `assertAuthenticated` at the call site, so `type:"none"`
 * is unreachable here.
 */
function resolveCompanyId(req: Request, requestedCompanyId: string | undefined): string {
  if (req.actor.type === "agent") {
    const agentCompanyId = req.actor.companyId;
    if (!agentCompanyId) {
      throw forbidden("Agent actor is missing a company binding");
    }
    if (requestedCompanyId && requestedCompanyId !== agentCompanyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return agentCompanyId;
  }

  if (req.actor.type === "board") {
    if (!requestedCompanyId) {
      throw forbidden("companyId is required for board-token callers");
    }
    assertCompanyAccess(req, requestedCompanyId);
    return requestedCompanyId;
  }

  // Defensive — assertAuthenticated already rejected `type:"none"`.
  throw forbidden("Unsupported actor type for slack thread links");
}

export function slackThreadLinkRoutes(db: Db) {
  const router = Router();
  const svc = slackThreadLinkService(db);

  router.post("/slack/thread-links", validate(createSchema), async (req, res) => {
    assertAuthenticated(req);
    const companyId = resolveCompanyId(req, req.body.companyId);
    try {
      const { row, created } = await svc.create({
        companyId,
        threadTs: req.body.threadTs,
        channelId: req.body.channelId,
        paperclipResourceType: req.body.paperclipResourceType,
        paperclipResourceId: req.body.paperclipResourceId,
      });
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
    const companyId = resolveCompanyId(req, query.company_id);
    const row = await svc.findByThreadTs(companyId, ts, query.channel_id);
    if (!row) {
      throw notFound("Slack thread link not found");
    }
    res.json(row);
  });

  return router;
}
