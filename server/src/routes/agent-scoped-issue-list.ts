/**
 * GET /api/agents/me/issues
 *
 * Scoped issue list for agent keys — the primary listing surface for
 * `task_bridge` keys, which are barred from the company-wide list APIs.
 *
 * Authorization model:
 * - `task_bridge` keys: results are fenced to `keyScope.projectIds` AND
 *   `keyScope.allowedAssigneeAgentIds` (plus the key's own agent). Optional
 *   `projectId` / `assigneeAgentId` query filters are accepted only when they
 *   fall inside those boundaries; a value outside the fence returns 403.
 *   `assigneeAgentId=null` ("unassigned") is disallowed for task_bridge keys:
 *   an unassigned issue is outside the assignee fence by definition.
 *   A key that carries only a parent-issue boundary and no project IDs
 *   returns `{ items: [], hasMore: false }` because this endpoint is
 *   project-scoped; there is no project set to enumerate.
 * - Standard/regular agent keys: unrestricted — they already have company-wide
 *   access via normal agent auth. Filters are applied as-is.
 *
 * Response: `{ items: [...], hasMore: boolean }`.
 *   `hasMore: true` means there are results beyond the current page;
 *   the caller should repeat with `offset += limit` to paginate.
 *
 * The response never silently truncates: if `hasMore` is false, `items` is
 * the complete set matching the filter inside the caller's scope.
 */

import { z } from "zod";
import { Router } from "express";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueService,
} from "../services/index.js";
import {
  isSkillTestKeyActor,
  isTaskBridgeKeyActor,
  skillTestKeyScopedIssueId,
  taskBridgeKeyScope,
  taskBridgeScopeAssigneeAgentIds,
  taskBridgeScopeProjectIds,
} from "./task-bridge-scope.js";

const agentScopedIssueListQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform((v) => Number.parseInt(v, 10))
    .refine((v) => v > 0 && v <= ISSUE_LIST_MAX_LIMIT, {
      message: `limit must be a positive integer up to ${ISSUE_LIST_MAX_LIMIT}`,
    })
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/)
    .transform((v) => Number.parseInt(v, 10))
    .refine((v) => v >= 0, { message: "offset must be a non-negative integer" })
    .optional(),
  status: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v === undefined) return true;
        const parts = v.split(",").map((s) => s.trim());
        return parts.every((p) =>
          (ISSUE_STATUSES as readonly string[]).includes(p),
        );
      },
      { message: "status contains an unknown value" },
    ),
  projectId: z.string().uuid("projectId must be a UUID").optional(),
  assigneeAgentId: z
    .union([z.literal("null"), z.string().uuid("assigneeAgentId must be a UUID or 'null'")])
    .optional(),
  /**
   * Optional free-text search. Applied as a case-insensitive ILIKE filter against
   * the issue identifier and title. Scoped to the same task_bridge fence as the
   * other filters: a query that matches only out-of-fence records returns an empty
   * page, not a 403 — the filter narrows a set that is already fenced.
   */
  q: z.string().trim().min(1).max(500).optional(),
});

export function agentScopedIssueListRoute(db: Db): Router {
  const router = Router();

  router.get("/agents/me/issues", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    // A `skill_test` run token is narrowed to ONE issue by the harness that
    // issued it. It is not a company-wide key that merely lacks a fence, so the
    // unrestricted branch below must never be reachable from one: an enumeration
    // of every visible issue is strictly wider than the single issue the token
    // was minted for. Refused here rather than filtered down to `issueId`,
    // because a list route is not the surface a single-issue token needs — the
    // issue-read route already serves it. This mirrors the refusal the issue
    // create route applies to the same scope.
    if (isSkillTestKeyActor(req)) {
      res.status(403).json({
        error: "Skill-test run tokens cannot list issues.",
        details: {
          scopedIssueId: skillTestKeyScopedIssueId(req),
          securityPrinciples: [
            "Least Privilege",
            "Complete Mediation",
            "Fail Securely",
          ],
        },
      });
      return;
    }

    const companyId = req.actor.companyId;
    const actorAgentId = req.actor.agentId;

    const parsed = agentScopedIssueListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => i.message).join("; "),
      });
      return;
    }

    const {
      limit: parsedLimit,
      offset,
      status,
      projectId: rawProjectId,
      assigneeAgentId: rawAssigneeAgentId,
      q,
    } = parsed.data;

    const limit = parsedLimit ?? ISSUE_LIST_DEFAULT_LIMIT;
    const resolvedOffset = offset ?? 0;

    // Normalize `assigneeAgentId` — the string "null" is the sentinel for
    // "unassigned"; anything else is a UUID; absent means no filter.
    const requestedAssigneeAgentId: string | null | undefined =
      rawAssigneeAgentId === "null"
        ? null
        : rawAssigneeAgentId;

    // -- task_bridge fence checks -------------------------------------------
    let projectIdsFilter: string[] | undefined;
    let assigneeAgentIdsFilter: string[] | undefined;

    const isBridgeKey = isTaskBridgeKeyActor(req);
    if (isBridgeKey) {
      const bridgeScope = taskBridgeKeyScope(req);
      if (!bridgeScope) {
        // Defensive: isTaskBridgeKeyActor already confirmed the shape; this
        // branch should be unreachable.
        res.status(400).json({ error: "Invalid task_bridge key scope" });
        return;
      }

      const allowedProjectIds = taskBridgeScopeProjectIds(bridgeScope);
      const allowedAssigneeIds = taskBridgeScopeAssigneeAgentIds(
        bridgeScope,
        actorAgentId,
      );

      // Parent-only bridge keys carry no project boundary — return a clean
      // empty instead of accidentally querying without a project constraint.
      if (allowedProjectIds.length === 0) {
        res.json({ items: [], hasMore: false });
        return;
      }

      // `assigneeAgentId=null` means "unassigned" — unassigned issues are
      // outside the assignee fence and are therefore not accessible.
      if (requestedAssigneeAgentId === null) {
        res.status(403).json({
          error: "task_bridge keys cannot request unassigned issues",
        });
        return;
      }

      // Validate the requested projectId against the fence.
      if (rawProjectId !== undefined) {
        if (!allowedProjectIds.includes(rawProjectId)) {
          res.status(403).json({
            error: "Project is outside this key's approved scope",
          });
          return;
        }
        // Single project within scope — service-level `projectId` filter
        // already narrows it; no need for the array filter.
        projectIdsFilter = undefined;
      } else {
        projectIdsFilter = allowedProjectIds;
      }

      // Validate the requested assigneeAgentId against the fence.
      if (requestedAssigneeAgentId !== undefined) {
        if (!allowedAssigneeIds.includes(requestedAssigneeAgentId)) {
          res.status(403).json({
            error: "Agent is outside this key's approved scope",
          });
          return;
        }
        assigneeAgentIdsFilter = undefined;
      } else {
        assigneeAgentIdsFilter = allowedAssigneeIds;
      }
    }

    // -- Query ---------------------------------------------------------------
    // Fetch limit+1 rows so `hasMore` is correct without a separate COUNT.
    const fetchLimit = limit + 1;
    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(companyId, {
      status,
      assigneeAgentId: requestedAssigneeAgentId,
      projectId: rawProjectId,
      projectIds: projectIdsFilter,
      assigneeAgentIds: assigneeAgentIdsFilter,
      q,
      limit: fetchLimit,
      offset: resolvedOffset,
    });

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      projectId: row.projectId,
      parentId: row.parentId,
      assigneeAgentId: row.assigneeAgentId,
      assigneeUserId: row.assigneeUserId,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    }));

    res.json({ items, hasMore });
  });

  return router;
}
