import {
  runDraftPolishStep,
  runDraftReviewStep,
  runDraftStep,
  runFinalReviewStep,
  runImageStep,
  runPublicVerifyStep,
  runResearchStep,
  runValidateStep,
  type BlogPipelineStepInput,
} from "@paperclipai/blog-pipeline-core";
import {
  assertWordPressWriteAllowedForLane,
} from "@paperclipai/blog-pipeline-policy";
import type { Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { resolveDefaultBlogRunsDir } from "../home-paths.js";
import { blogPublisherService } from "./blog-publisher.js";
import { blogRunService } from "./blog-runs.js";

type StepClaim = {
  run?: Record<string, unknown> | null;
  attempt?: Record<string, unknown> | null;
};

type WorkerDeps = {
  runResearchStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  runDraftStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  runImageStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  runDraftReviewStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  runDraftPolishStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  runFinalReviewStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  runValidateStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  runPublicVerifyStep?: (input: BlogPipelineStepInput) => Promise<Record<string, unknown> | null>;
  publisher?: ReturnType<typeof blogPublisherService>;
  runService?: ReturnType<typeof blogRunService>;
  artifactRoot?: string;
};

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function requireString(value: unknown, message: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

export function blogRunWorkerService(db: Db, deps: WorkerDeps = {}) {
  const runs = deps.runService ?? blogRunService(db);
  const publisher = deps.publisher ?? blogPublisherService(db);

  async function executeClaimedStep(claim: StepClaim) {
    const run = toRecord(claim.run);
    const attempt = toRecord(claim.attempt);
    const runId = requireString(run.id, "blog_run_missing");
    const stepKey = requireString(attempt.stepKey, "blog_run_step_missing");
    const attemptId = requireString(attempt.id, "blog_run_attempt_missing");
    const lane = String(run.lane ?? "publish");
    const runDir = `${(deps.artifactRoot ?? resolveDefaultBlogRunsDir()).replace(/\/+$/, "")}/${runId}`;

    const input: BlogPipelineStepInput = {
      runDir,
      context: toRecord(run.contextJson),
    };

    try {
      let result: Record<string, unknown> | null = null;

      switch (stepKey) {
        case "research":
          result = await (deps.runResearchStep ?? runResearchStep)(input);
          break;
        case "draft":
          result = await (deps.runDraftStep ?? runDraftStep)(input);
          break;
        case "image":
          result = await (deps.runImageStep ?? runImageStep)(input);
          break;
        case "draft_review":
          result = await (deps.runDraftReviewStep ?? runDraftReviewStep)(input);
          break;
        case "draft_polish":
          result = await (deps.runDraftPolishStep ?? runDraftPolishStep)(input);
          break;
        case "final_review":
          result = await (deps.runFinalReviewStep ?? runFinalReviewStep)(input);
          break;
        case "validate": {
          result = await (deps.runValidateStep ?? runValidateStep)(input);
          if (result && result.ok === false) {
            throw new Error("blog_run_validation_failed");
          }
          break;
        }
        case "publish": {
          const draft = toRecord(run.contextJson);
          const title = requireString(draft.title ?? draft.topic ?? run.topic, "publish_title_missing");
          const content = requireString(draft.article_html ?? draft.content, "publish_content_missing");
          if (String(run.publishMode ?? "draft") === "dry_run") {
            result = {
              mode: "dry-run",
              payloadPreview: {
                title,
                content,
                status: "draft",
                slug: String(run.targetSlug ?? "").trim() || null,
              },
            };
            break;
          }

          assertWordPressWriteAllowedForLane(lane);
          const runDetail = await runs.getDetail(runId);
          const latestApproval = Array.isArray(runDetail?.approvals) ? runDetail.approvals[0] : null;
          const approvalId = requireString(
            (latestApproval as Record<string, unknown> | null)?.id
            ?? run.approvalId
            ?? run.latestApprovalId
            ?? run.approvalKeyHash,
            "publish_approval_missing",
          );
          const publishIdempotencyKey = requireString(run.publishIdempotencyKey, "publish_idempotency_key_missing");
          const publishResult = normalizePublishResult(
            String(run.publishMode ?? "draft") === "publish"
              ? await publisher.publishPost({
                  blogRunId: runId,
                  companyId: requireString(run.companyId, "company_id_missing"),
                  approvalId,
                  publishIdempotencyKey,
                  siteId: requireString(run.targetSite, "target_site_missing"),
                  targetSlug: String(run.targetSlug ?? "").trim() || undefined,
                  title,
                  content,
                })
              : await publisher.publishDraft({
                  blogRunId: runId,
                  companyId: requireString(run.companyId, "company_id_missing"),
                  approvalId,
                  publishIdempotencyKey,
                  siteId: requireString(run.targetSite, "target_site_missing"),
                  targetSlug: String(run.targetSlug ?? "").trim() || undefined,
                  title,
                  content,
                }),
          );
          result = publishResult;
          break;
        }
        case "public_verify":
          result = String(run.publishMode ?? "draft") === "dry_run"
            ? {
                ok: true,
                mode: "dry-run",
                checks: {
                  publish_file_present: true,
                  payload_preview_present: true,
                },
              }
            : await (deps.runPublicVerifyStep ?? runPublicVerifyStep)(input);
          if (result && result.ok === false) {
            throw new Error("blog_run_public_verify_failed");
          }
          break;
        default:
          throw new Error(`unsupported_blog_run_step:${stepKey}`);
      }

      return runs.completeStep(runId, stepKey, {
        attemptId,
        resultJson: result ?? {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return runs.failStep(runId, stepKey, {
        attemptId,
        errorCode: message.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "BLOG_RUN_STEP_FAILED",
        errorMessage: message,
      });
    }
  }

  return {
    async runNext(runId: string) {
      const run = await runs.getById(runId);
      if (!run) throw notFound("Blog run not found");
      if (!run.currentStep) return runs.getDetail(runId);
      if (run.status === "publish_approval_pending") {
        throw conflict("Publish approval is required before running publish");
      }
      const claim = await runs.claimNextStep(runId);
      if (!claim) return runs.getDetail(runId);
      return executeClaimedStep(claim);
    },

    executeClaimedStep,
  };
}

function normalizePublishResult(result: unknown) {
  const record = toRecord(result);
  const post = toRecord(record.post);
  return {
    reusedExecution: Boolean(record.reusedExecution),
    authenticatedUser: record.authenticatedUser ?? null,
    postId: post.id ?? null,
    status: post.status ?? null,
    url: post.link ?? null,
    featuredMedia: record.featuredMedia ?? null,
    supportingMedia: Array.isArray(record.supportingMedia) ? record.supportingMedia : [],
  };
}
