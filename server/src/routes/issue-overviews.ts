import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { ISSUE_OVERVIEW_MAX_IDS, issueOverviewService } from "../services/issue-overviews.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Board-only, read-only batch projection.
 *
 *   GET /api/companies/:companyId/issue-overviews?issueIds=<comma UUIDs>
 *
 * The company boundary is enforced by `assertCompanyAccess` and again by every
 * query in the service, so ids from another company resolve to nothing rather
 * than to a row. The route reads; it never writes an issue status and never
 * reconciles GitHub.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Malformed input is a 400; valid-but-unknown ids are simply absent from the
 * response, which is the same answer a wrong-company id gets.
 */
export function parseIssueOverviewIds(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "string") throw badRequest("issueIds must be a comma-separated list of issue ids");
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const seen = new Set<string>();
  for (const part of trimmed.split(",")) {
    const candidate = part.trim();
    if (!candidate) continue;
    if (!UUID_PATTERN.test(candidate)) throw badRequest("issueIds must be a comma-separated list of issue UUIDs");
    seen.add(candidate.toLowerCase());
  }
  if (seen.size > ISSUE_OVERVIEW_MAX_IDS) {
    throw badRequest(`issueIds accepts at most ${ISSUE_OVERVIEW_MAX_IDS} unique ids`);
  }
  return [...seen];
}

export function issueOverviewRoutes(db: Db) {
  const router = Router();
  const overviews = issueOverviewService(db);

  router.get("/companies/:companyId/issue-overviews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const issueIds = parseIssueOverviewIds(req.query.issueIds);
    const response = await overviews.list(companyId, issueIds);
    res.json(response);
  });

  return router;
}
