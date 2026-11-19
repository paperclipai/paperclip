import type { Request, Response } from "express";
import type { accessService } from "../services/index.js";
import { getAccessibleResource } from "./authz.js";

interface ReadableIssueFields {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
}

/**
 * The task when the actor may read it. Company access alone is not enough: a
 * private task stays hidden from members who cannot read it. A denial answers
 * with the same 404 as a missing task, so the task's existence does not leak.
 */
export async function getReadableIssue<T extends ReadableIssueFields>(
  access: ReturnType<typeof accessService>,
  req: Request,
  res: Response,
  issue: T | null | undefined | Promise<T | null | undefined>,
  notFoundMessage: string,
): Promise<T | null> {
  const resolved = await getAccessibleResource(req, res, issue, notFoundMessage);
  if (!resolved) return null;
  const decision = await access.decide({
    actor: req.actor,
    action: "issue:read",
    resource: {
      type: "issue",
      companyId: resolved.companyId,
      issueId: resolved.id,
      projectId: resolved.projectId,
      parentIssueId: resolved.parentId,
      assigneeAgentId: resolved.assigneeAgentId,
      assigneeUserId: resolved.assigneeUserId,
      status: resolved.status,
    },
    scope: {
      issueId: resolved.id,
      projectId: resolved.projectId,
      parentIssueId: resolved.parentId,
      assigneeAgentId: resolved.assigneeAgentId,
      assigneeUserId: resolved.assigneeUserId,
    },
  });
  if (decision.allowed) return resolved;
  res.status(404).json({ error: notFoundMessage });
  return null;
}
