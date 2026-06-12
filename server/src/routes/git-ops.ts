import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { gitPushRequestSchema, openPullRequestSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { gitOpsService } from "../services/git-ops.js";

// Server-side git-ops endpoints. These are the credentialed half of the
// "commit local, ship by tool" flow: the assigned agent commits in its
// worktree (no credentials), then calls these routes to push and open a PR.
// Hard boundary: actor must be an agent; the service additionally enforces
// that the agent is the issue's assignee. Push/PR targets are derived
// server-side — agents never supply repo, remote, branch, or base.
export function gitOpsRoutes(db: Db) {
  const router = Router();
  const svc = gitOpsService(db);

  function requireAgentActor(req: Request): { agentId: string; companyId: string } | null {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      return null;
    }
    return { agentId: req.actor.agentId, companyId: req.actor.companyId };
  }

  router.post("/issues/:id/git/push", validate(gitPushRequestSchema), async (req, res) => {
    const actor = requireAgentActor(req);
    if (!actor) {
      res.status(403).json({ error: "Git-ops is for the assigned agent only" });
      return;
    }
    const result = await svc.pushIssueBranch(req.params.id as string, actor);
    res.json(result);
  });

  router.post("/issues/:id/git/pr", validate(openPullRequestSchema), async (req, res) => {
    const actor = requireAgentActor(req);
    if (!actor) {
      res.status(403).json({ error: "Git-ops is for the assigned agent only" });
      return;
    }
    const result = await svc.openIssuePullRequest(req.params.id as string, actor, {
      title: req.body.title,
      body: req.body.body ?? null,
      draft: req.body.draft,
    });
    res.json(result);
  });

  return router;
}
