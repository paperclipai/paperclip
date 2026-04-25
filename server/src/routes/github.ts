import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { prCiStatus, projectWorkspaces } from "@paperclipai/db";
import { eq, and, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { verifyIssueProofByCiResult } from "../services/proof-verification.js";
import {
  createReviewState,
  recordBuilderPosition,
  recordBreakerPosition,
  completeReview,
  getReviewState,
  invokeJury,
  type ReviewPosition,
} from "../services/adversarial-review.js";

const webhookPayloadSchema = z.object({
  action: z.string().optional(),
  workflow_run: z
    .object({
      id: z.number(),
      name: z.string().optional(),
      head_sha: z.string(),
      conclusion: z.string().nullable(),
      status: z.string(),
      html_url: z.string(),
      pull_requests: z
        .array(
          z.object({
            number: z.number(),
            base: z.object({ repo: z.object({ full_name: z.string() }) }),
          }),
        )
        .optional(),
    })
    .optional(),
  check_run: z
    .object({
      id: z.number(),
      name: z.string(),
      conclusion: z.string().nullable(),
      status: z.string(),
      html_url: z.string(),
      pull_requests: z
        .array(
          z.object({
            number: z.number(),
            base: z.object({ repo: z.object({ full_name: z.string() }) }),
          }),
        )
        .optional(),
    })
    .optional(),
  pull_request: z
    .object({
      number: z.number(),
      head: z.object({ sha: z.string() }),
      base: z.object({ repo: z.object({ full_name: z.string() }) }),
    })
    .optional(),
  review: z
    .object({
      id: z.number(),
      state: z.string(),
      pull_request: z.object({
        number: z.number(),
        head: z.object({ sha: z.string() }),
        base: z.object({ repo: z.object({ full_name: z.string() }) }),
      }),
    })
    .optional(),
});

type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

function verifyGitHubWebhookSignature(
  payload: Buffer,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const crypto = require("node:crypto");
  const hmac = crypto.createHmac("sha256", secret);
  const digest = "sha256=" + hmac.update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function githubWebhookRoutes(db: Db) {
  const router = Router();

  router.post(
    "/webhook",
    async (req: Request, res: Response) => {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

      if (webhookSecret && signature !== undefined) {
        const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
        if (!verifyGitHubWebhookSignature(rawBody || Buffer.from(""), signature, webhookSecret)) {
          logger.warn("GitHub webhook signature verification failed");
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      }

      const payload = webhookPayloadSchema.safeParse(req.body);
      if (!payload.success) {
        logger.warn({ error: payload.error.flatten() }, "Invalid GitHub webhook payload");
        res.status(400).json({ error: "Invalid payload format" });
        return;
      }

      const data = payload.data;

      try {
        if (data.workflow_run) {
          await handleWorkflowRun(db, data);
        } else if (data.check_run) {
          await handleCheckRun(db, data);
        } else if (data.pull_request) {
          await handlePullRequest(db, data);
        } else if (data.review) {
          await handleReview(db, data);
        }

        res.status(200).json({ received: true });
      } catch (err) {
        logger.error({ err }, "Error processing GitHub webhook");
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  return router;
}

async function handleWorkflowRun(db: Db, data: WebhookPayload) {
  if (!data.workflow_run) return;
  const run = data.workflow_run;

  if (!run.pull_requests || run.pull_requests.length === 0) {
    logger.debug("Workflow run has no associated PRs, skipping");
    return;
  }

  for (const pr of run.pull_requests) {
    const repoFullName = pr.base.repo.full_name;
    const prNumber = pr.number;
    const headSha = run.head_sha;

    const existing = await db.query.prCiStatus.findFirst({
      where: and(
        eq(prCiStatus.workflowRunId, String(run.id)),
        eq(prCiStatus.repositoryFullName, repoFullName),
      ),
    });

    if (existing) {
      await db
        .update(prCiStatus)
        .set({
          conclusion: run.conclusion,
          status: run.status,
          url: run.html_url,
          updatedAt: new Date(),
        })
        .where(eq(prCiStatus.id, existing.id));
    } else {
      await db.insert(prCiStatus).values({
        id: randomUUID(),
        companyId: "00000000-0000-0000-0000-000000000000",
        repositoryFullName: repoFullName,
        prNumber: prNumber,
        headSha: headSha,
        workflowRunId: String(run.id),
        conclusion: run.conclusion,
        status: run.status,
        url: run.html_url,
        receivedAt: new Date(),
        updatedAt: new Date(),
      });
    }

    if (run.conclusion === "success" && run.status === "completed") {
      const verified = await verifyIssueProofByCiResult(db, {
        repositoryFullName: repoFullName,
        prNumber,
        headSha,
      });
      if (verified.length > 0) {
        logger.info(
          { repoFullName, prNumber, verifiedIssues: verified.map((v) => v.identifier) },
          "Issue proofs verified via CI result",
        );
      }
    }
  }
}

async function handleCheckRun(db: Db, data: WebhookPayload) {
  if (!data.check_run) return;
  const check = data.check_run;

  if (!check.pull_requests || check.pull_requests.length === 0) {
    logger.debug("Check run has no associated PRs, skipping");
    return;
  }

  for (const pr of check.pull_requests) {
    const repoFullName = pr.base.repo.full_name;
    const prNumber = pr.number;

    const existing = await db.query.prCiStatus.findFirst({
      where: and(
        eq(prCiStatus.checkRunId, String(check.id)),
        eq(prCiStatus.repositoryFullName, repoFullName),
      ),
    });

    if (existing) {
      await db
        .update(prCiStatus)
        .set({
          conclusion: check.conclusion,
          status: check.status,
          url: check.html_url,
          updatedAt: new Date(),
        })
        .where(eq(prCiStatus.id, existing.id));
    } else {
      await db.insert(prCiStatus).values({
        id: randomUUID(),
        companyId: "00000000-0000-0000-0000-000000000000",
        repositoryFullName: repoFullName,
        prNumber: prNumber,
        headSha: "",
        checkRunId: String(check.id),
        checkRunName: check.name,
        conclusion: check.conclusion,
        status: check.status,
        url: check.html_url,
        receivedAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

async function handlePullRequest(db: Db, data: WebhookPayload) {
  if (!data.pull_request) return;
  const pr = data.pull_request;

  logger.info(
    { repo: pr.base.repo.full_name, prNumber: pr.number, headSha: pr.head.sha, action: data.action },
    "PR event received",
  );

  if (data.action === "opened" || data.action === "synchronize") {
    const companyId = await resolveCompanyIdForRepo(db, pr.base.repo.full_name);
    if (companyId) {
      try {
        await createReviewState(
          db,
          companyId,
          pr.base.repo.full_name,
          pr.number,
          pr.head.sha,
          "00000000-0000-0000-0000-000000000000",
        );
        logger.info({ repo: pr.base.repo.full_name, prNumber: pr.number, headSha: pr.head.sha }, "Created adversarial review state for PR");
      } catch (err) {
        logger.warn({ err, repo: pr.base.repo.full_name, prNumber: pr.number }, "Failed to create adversarial review state");
      }
    }
  }
}

async function handleReview(db: Db, data: WebhookPayload) {
  if (!data.review) return;
  const review = data.review;

  const repoFullName = review.pull_request.base.repo.full_name;
  const prNumber = review.pull_request.number;
  const headSha = review.pull_request.head.sha;

  const existing = await db.query.prCiStatus.findFirst({
    where: and(
      eq(prCiStatus.repositoryFullName, repoFullName),
      eq(prCiStatus.prNumber, prNumber),
    ),
  });

  if (existing) {
    await db
      .update(prCiStatus)
      .set({
        reviewState: review.state,
        reviewApprovedAt: review.state === "approved" ? new Date() : existing.reviewApprovedAt,
        reviewApprovedBy: review.state === "approved" ? `review_${review.id}` : existing.reviewApprovedBy,
        updatedAt: new Date(),
      })
      .where(eq(prCiStatus.id, existing.id));
  }

  const companyId = await resolveCompanyIdForRepo(db, repoFullName);
  if (companyId) {
    const reviewPosition: ReviewPosition = review.state as ReviewPosition;
    const state = await getReviewState(db, repoFullName, prNumber, headSha);

    if (state) {
      if (state.builderPosition === null) {
        try {
          await recordBuilderPosition(
            db,
            repoFullName,
            prNumber,
            headSha,
            reviewPosition,
          );
          logger.info({ repoFullName, prNumber, headSha, position: reviewPosition }, "Recorded builder position in adversarial review");
        } catch (err) {
          logger.warn({ err, repoFullName, prNumber, headSha }, "Failed to record builder position");
        }
      } else {
        const breakerAgentId = "00000000-0000-0000-0000-000000000000";
        const breakerFamily = "openai";
        try {
          const result = await recordBreakerPosition(
            db,
            repoFullName,
            prNumber,
            headSha,
            reviewPosition,
            breakerAgentId,
            breakerFamily,
          );
          logger.info(
            { repoFullName, prNumber, headSha, round: result.state.round, juryTriggered: result.juryTriggered },
            "Recorded breaker position in adversarial review",
          );

          if (result.state.juryInvoked && !result.state.reviewComplete) {
            await invokeJury(db, repoFullName, prNumber, headSha);
          }

          if (review.state === "approved" && !result.state.juryInvoked) {
            await completeReview(db, repoFullName, prNumber, headSha, "approved_by_reviewer");
          }
        } catch (err) {
          logger.warn({ err, repoFullName, prNumber, headSha }, "Failed to record breaker position");
        }
      }
    }
  }

  if (review.state === "approved") {
    logger.info({ repoFullName, prNumber }, "PR approved, triggering proof verification");
    const verified = await verifyIssueProofByCiResult(db, {
      repositoryFullName: repoFullName,
      prNumber,
      headSha: "",
    });
    if (verified.length > 0) {
      logger.info(
        { repoFullName, prNumber, verifiedIssues: verified.map((v) => v.identifier) },
        "Issue proofs verified via review approval",
      );
    }
  }
}

async function resolveCompanyIdForRepo(db: Db, repositoryFullName: string): Promise<string | null> {
  const workspace = await db.query.projectWorkspaces.findFirst({
    where: like(projectWorkspaces.repoUrl, `%${repositoryFullName}%`),
  });
  return workspace?.companyId ?? null;
}
