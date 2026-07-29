import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueWorkProducts } from "@paperclipai/db";
import { issueService, logActivity } from "../services/index.js";
import { logger } from "../middleware/logger.js";

const ISSUE_IDENTIFIER_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

function extractIssueIdentifiers(text: string): string[] {
  const matches = text.match(ISSUE_IDENTIFIER_RE);
  return matches ? [...new Set(matches)] : [];
}

function verifySignature(secret: string, payload: Buffer, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(signature);
  if (expectedBuf.length !== sigBuf.length) return false;
  return timingSafeEqual(expectedBuf, sigBuf);
}

interface PullRequestPayload {
  action: string;
  pull_request: {
    merged: boolean;
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    base: { repo: { full_name: string } };
  };
}

export function githubWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/github/webhooks", async (req: Request, res: Response) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      logger.warn("GITHUB_WEBHOOK_SECRET not configured — rejecting webhook");
      res.status(503).json({ error: "GitHub webhooks not configured" });
      return;
    }

    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== "string") {
      res.status(401).json({ error: "Missing signature" });
      return;
    }

    const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
    if (!rawBody || !verifySignature(secret, rawBody, signature)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = req.headers["x-github-event"];
    if (event !== "pull_request") {
      res.status(200).json({ ignored: true, reason: "not a pull_request event" });
      return;
    }

    const payload = req.body as PullRequestPayload;
    if (payload.action !== "closed" || !payload.pull_request?.merged) {
      res.status(200).json({ ignored: true, reason: "PR not merged" });
      return;
    }

    const pr = payload.pull_request;
    const prUrl = pr.html_url;
    const prNumber = pr.number;
    const repoFullName = pr.base.repo.full_name;

    const textToSearch = `${pr.title}\n${pr.body ?? ""}`;
    const identifiers = extractIssueIdentifiers(textToSearch);

    const closedIssueIds: string[] = [];
    const svc = issueService(db);

    if (identifiers.length > 0) {
      const matchedIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          status: issues.status,
          companyId: issues.companyId,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.identifier, identifiers),
            eq(issues.status, "in_review"),
          ),
        );

      for (const issue of matchedIssues) {
        await svc.update(issue.id, {
          status: "done",
        });
        await svc.addComment(
          issue.id,
          `Auto-closed: PR [#${prNumber}](${prUrl}) merged in \`${repoFullName}\``,
          { agentId: undefined, userId: undefined, runId: null },
        );
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "system",
          action: "issue.auto_closed_pr_merged",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            prUrl,
            prNumber,
            repoFullName,
          },
        });
        closedIssueIds.push(issue.id);
        logger.info({ issueId: issue.id, identifier: issue.identifier, prUrl }, "Auto-closed issue on PR merge");
      }
    }

    const workProductIssues = await db
      .select({
        issueId: issueWorkProducts.issueId,
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        companyId: issues.companyId,
      })
      .from(issueWorkProducts)
      .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
      .where(
        and(
          eq(issueWorkProducts.type, "pull_request"),
          eq(issueWorkProducts.url, prUrl),
          eq(issues.status, "in_review"),
        ),
      );

    for (const issue of workProductIssues) {
      if (closedIssueIds.includes(issue.id)) continue;

      await svc.update(issue.id, {
        status: "done",
      });
      await svc.addComment(
        issue.id,
        `Auto-closed: PR [#${prNumber}](${prUrl}) merged in \`${repoFullName}\``,
        { agentId: undefined, userId: undefined, runId: null },
      );
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.auto_closed_pr_merged",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          prUrl,
          prNumber,
          repoFullName,
        },
      });
      closedIssueIds.push(issue.id);
      logger.info({ issueId: issue.id, identifier: issue.identifier, prUrl }, "Auto-closed issue on PR merge (work product link)");
    }

    res.status(200).json({
      processed: true,
      closedIssueCount: closedIssueIds.length,
      closedIssueIds,
    });
  });

  return router;
}
