import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { prCiStatus } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";

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
    { repo: pr.base.repo.full_name, prNumber: pr.number, action: data.action },
    "PR event received",
  );
}
