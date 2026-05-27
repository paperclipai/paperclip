// BLO-4141: admin endpoint that auto-bumps agents.adapter_config.image
// after docker-agent.yml builds a new paperclip-agent image. Called by
// .github/workflows/docker-agent.yml with a board token.
//
// Eligibility: claude_k8s + opencode_k8s agents in the target company that
// have adapter_config.image set and don't already match the target. Busy
// agents (queued/running heartbeat run, or active k8s Job) are deferred:
// pending_image_bump gets set and the heartbeat run-completion hook retries
// on the agent's next terminal run.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { bumpAgentImagesForCompany } from "../services/agent-image-bump.js";

const bumpAgentImageSchema = z.object({
  companyId: z.string().uuid(),
  image: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[\w./@:-]+$/, "image must be a valid container reference"),
  source: z.string().min(1).max(120).optional().default("admin:manual"),
  buildSha: z.string().min(1).max(40).optional(),
});

export function agentImageBumpRoutes(db: Db) {
  const router = Router();

  router.post(
    "/admin/agents/bump-agent-image",
    validate(bumpAgentImageSchema),
    async (req, res) => {
      const body = req.body as z.infer<typeof bumpAgentImageSchema>;

      // Bumping is a platform-ops action, not an agent action. Only board
      // tokens with agents:create can call it; agent-actor tokens (even CEO)
      // are deliberately excluded.
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      assertCompanyAccess(req, body.companyId);

      const source = body.buildSha ? `${body.source}@${body.buildSha}` : body.source;
      const summary = await bumpAgentImagesForCompany(db, {
        companyId: body.companyId,
        targetImage: body.image,
        source,
      });

      res.json(summary);
    },
  );

  return router;
}
