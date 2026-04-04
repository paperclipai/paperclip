import fs from "node:fs/promises";
import path from "node:path";
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
  publicVerifyContractMode?: "compat" | "strict";
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

function isSharedPublicVerifyPayload(value: unknown): value is Record<string, unknown> {
  const record = toRecord(value);
  return String(record.schemaVersion ?? "").trim() === "shared-public-verify.v1"
    && typeof record.verdict === "string"
    && Array.isArray(record.coreChecks)
    && Array.isArray(record.failureNames);
}

function publicVerifyFailureMessage(result: unknown) {
  const record = toRecord(result);
  if (isSharedPublicVerifyPayload(record)) {
    const failures = Array.isArray(record.failureNames)
      ? record.failureNames.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    return failures.length > 0
      ? `blog_run_public_verify_failed:${failures.join(",")}`
      : "blog_run_public_verify_failed";
  }
  return "blog_run_public_verify_failed";
}

function isPublicVerifyPass(result: unknown) {
  const record = toRecord(result);
  if (isSharedPublicVerifyPayload(record)) {
    return String(record.verdict ?? "").trim() === "pass";
  }
  return record.ok !== false;
}

function resolvePublicVerifyContractMode(
  run: Record<string, unknown>,
  depsMode: WorkerDeps["publicVerifyContractMode"],
) {
  const context = toRecord(run.contextJson);
  const configured = firstNonEmptyString(
    depsMode,
    run.publicVerifyContractMode,
    context.publicVerifyContractMode,
  ).toLowerCase();
  return configured === "strict" ? "strict" : "compat";
}

async function readJsonArtifact(filePath: string) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return toRecord(parsed);
  } catch {
    return {};
  }
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function inferDecisionStateFromDraft(draft: Record<string, unknown>) {
  const explicit = firstNonEmptyString(
    draft.decisionState,
    draft.decision_state,
    draft.readerDecisionState,
    draft.reader_decision_state,
  ).toLowerCase();
  if (explicit === "adopt" || explicit === "wait" || explicit === "ignore" || explicit === "unclear") {
    return explicit;
  }
  const articleHtml = firstNonEmptyString(draft.article_html, draft.content).toLowerCase();
  if (/(무시해도|중요하지 않)/.test(articleHtml)) return "ignore";
  if (/(지켜볼|기다려|다음 업데이트)/.test(articleHtml)) return "wait";
  if (/(지금 바로|써볼 만|시험해볼 만|도입해볼 만)/.test(articleHtml)) return "adopt";
  return "unclear";
}

function inferDecisionSummaryFromDraft(draft: Record<string, unknown>, decisionState: string) {
  const explicit = firstNonEmptyString(
    draft.decisionSummary,
    draft.decision_summary,
    draft.readerDecisionSummary,
    draft.reader_decision_summary,
  );
  if (explicit) return explicit;
  switch (decisionState) {
    case "adopt":
      return "Approved draft expects the reader to reach an adopt decision.";
    case "wait":
      return "Approved draft expects the reader to wait for more confirmation.";
    case "ignore":
      return "Approved draft expects the reader to ignore the change for now.";
    default:
      return "Approved draft did not expose a strong decision signal for the reader.";
  }
}

function buildFailureNamesFromChecks(coreChecks: Array<Record<string, unknown>>) {
  const failures = new Set<string>();
  for (const check of coreChecks) {
    if (String(check.status ?? "") !== "fail") continue;
    const checkId = String(check.checkId ?? "");
    if (checkId === "public_visibility") failures.add("PUBLIC_VERIFY_REGRESSION");
    if (checkId === "title_framing") failures.add("TITLE_FRAMING_DRIFT");
    if (checkId === "body_contract") failures.add("BODY_CONTRACT_DRIFT");
    if (checkId === "media_and_status") failures.add("MEDIA_OR_STATUS_DRIFT");
    if (checkId === "artifact_parity") failures.add("SILENT_PUBLISH_DRIFT");
    if (checkId === "reader_decision") failures.add("READER_DECISION_UNCLEAR");
  }
  return [...failures];
}

async function normalizeLegacyPublicVerifyResult(
  run: Record<string, unknown>,
  runDir: string,
  legacyResult: Record<string, unknown>,
) {
  const draft = await readJsonArtifact(path.join(runDir, "draft.json"));
  const publish = await readJsonArtifact(path.join(runDir, "publish.json"));
  const checks = toRecord(legacyResult.checks);

  const issueIdentifier = firstNonEmptyString(run.issueIdentifier, run.issueId, run.id, path.basename(runDir));
  const artifactId = firstNonEmptyString(
    publish.approvalId,
    publish.publishIdempotencyKey,
    legacyResult.post_id,
    legacyResult.postId,
    run.id,
  ) || "publish-artifact";
  const artifactLabel = firstNonEmptyString(
    draft.title,
    run.topic,
    legacyResult.title,
    "Approved article",
  );
  const decisionState = inferDecisionStateFromDraft(draft);
  const decisionSummary = inferDecisionSummaryFromDraft(draft, decisionState);
  const expectedPublishStatus = firstNonEmptyString(publish.status, legacyResult.status, "publish").toLowerCase();
  const featuredMediaLabel = firstNonEmptyString(
    toRecord(publish.featured_media).title,
    publish.image ? path.basename(String(publish.image)) : "",
    "Featured media expectation",
  );
  const featuredMediaRequired = Boolean(publish.featured_media || publish.image);
  const observedPublishStatus = firstNonEmptyString(legacyResult.status, expectedPublishStatus, "unknown").toLowerCase();
  const observedFeaturedMediaPresent = Boolean(legacyResult.featured_media_id || legacyResult.featured_media_url);
  const publicVisibilityPass = Boolean(checks.public_fetch_ok);
  const titleFramingPass = Boolean(checks.title_matches);
  const bodyContractPass = Boolean(checks.post_found && checks.public_contains_title !== false);
  const mediaAndStatusPass = expectedPublishStatus === observedPublishStatus
    && (!featuredMediaRequired || observedFeaturedMediaPresent);
  const artifactParityPass = publicVisibilityPass && titleFramingPass && bodyContractPass && mediaAndStatusPass;
  const publicDecisionState = artifactParityPass ? decisionState : "unclear";
  const readerDecisionPass = publicDecisionState !== "unclear";

  const coreChecks = [
    {
      checkId: "public_visibility",
      status: publicVisibilityPass ? "pass" : "fail",
      overrideable: false,
      summary: publicVisibilityPass
        ? "The public URL stayed reachable during verify."
        : "The public URL did not remain reachable during verify.",
    },
    {
      checkId: "title_framing",
      status: titleFramingPass ? "pass" : "fail",
      overrideable: false,
      summary: titleFramingPass
        ? "The observed title preserved the approved framing."
        : "The observed title drifted from the approved framing.",
    },
    {
      checkId: "body_contract",
      status: bodyContractPass ? "pass" : "fail",
      overrideable: false,
      summary: bodyContractPass
        ? "The observed body still satisfied the approved article contract."
        : "The observed body no longer satisfied the approved article contract.",
    },
    {
      checkId: "media_and_status",
      status: mediaAndStatusPass ? "pass" : "fail",
      overrideable: false,
      summary: mediaAndStatusPass
        ? "Observed publish status and featured media matched the Publisher expectation."
        : "Observed publish status or featured media no longer matched the Publisher expectation.",
    },
    {
      checkId: "artifact_parity",
      status: artifactParityPass ? "pass" : "fail",
      overrideable: false,
      summary: artifactParityPass
        ? "Public output stayed aligned with the approved article."
        : "Public output drifted away from the approved article.",
    },
    {
      checkId: "reader_decision",
      status: readerDecisionPass ? "pass" : "fail",
      overrideable: false,
      summary: readerDecisionPass
        ? "The public page still leaves the reader with a clear decision."
        : "The public page no longer leaves the reader with a clear decision.",
    },
  ];

  const failureNames = buildFailureNamesFromChecks(coreChecks);
  const verdict = failureNames.length > 0 ? "fail" : "pass";
  const driftClass = verdict === "pass"
    ? "none"
    : String(coreChecks.find((entry) => entry.status === "fail")?.checkId ?? "artifact_parity");

  return {
    schemaVersion: "shared-public-verify.v1",
    verifyId: firstNonEmptyString(legacyResult.verify_id, legacyResult.post_id, legacyResult.postId, run.id, "public-verify"),
    approvedArtifactRef: {
      issueIdentifier,
      artifactId,
      artifactLabel,
    },
    approvedArtifact: {
      issueIdentifier,
      artifactId,
      artifactLabel,
      headline: firstNonEmptyString(draft.title, legacyResult.title, run.topic),
      decisionState,
      decisionSummary,
      requiredSections: ["verdict_overview", "evidence_breakdown", "who_should_adopt"],
    },
    publisherExpectations: {
      headline: firstNonEmptyString(draft.title, legacyResult.title, run.topic),
      decisionState,
      decisionSummary,
      publishStatus: expectedPublishStatus,
      featuredMedia: {
        required: featuredMediaRequired,
        label: featuredMediaLabel,
      },
    },
    publishReceiptId: firstNonEmptyString(legacyResult.receiptId, publish.receipt_id, publish.post_id, legacyResult.post_id, "publish-receipt"),
    publishReceiptLabel: firstNonEmptyString(
      legacyResult.receiptLabel,
      publish.generated_at ? `Publish receipt ${publish.generated_at}` : "",
      "Publish receipt",
    ),
    publishReceipt: {
      receiptId: firstNonEmptyString(legacyResult.receiptId, publish.receipt_id, publish.post_id, legacyResult.post_id, "publish-receipt"),
      label: firstNonEmptyString(
        legacyResult.receiptLabel,
        publish.generated_at ? `Publish receipt ${publish.generated_at}` : "",
        "Publish receipt",
      ),
      mode: publish.mode === "dry-run" ? "dry-run" : "live-run",
      lifecycle: publish.mode === "dry-run" ? "simulated" : "executed",
      target: "wordpress.production",
      targetUrl: firstNonEmptyString(legacyResult.link, publish.url, run.targetSite),
      publishedAt: firstNonEmptyString(legacyResult.verified_at, publish.generated_at, new Date().toISOString()),
    },
    publicUrl: firstNonEmptyString(legacyResult.link, publish.url, run.targetSite),
    verifiedAt: firstNonEmptyString(legacyResult.verified_at, new Date().toISOString()),
    verdict,
    readerDecisionState: publicDecisionState,
    readerDecisionSummary: readerDecisionPass
      ? "The public page still supports the approved reader decision."
      : "The public page no longer supports a clear reader decision.",
    coreChecks,
    failureNames,
    warnings: [],
    evidence: [
      {
        surface: "approved_package",
        signal: `headline=${firstNonEmptyString(draft.title, legacyResult.title, run.topic)}`,
      },
      {
        surface: "publication_receipt",
        signal: `status=${expectedPublishStatus} url=${firstNonEmptyString(legacyResult.link, publish.url, run.targetSite)}`,
      },
      {
        surface: "public_verify",
        signal: `http=${String(toRecord(legacyResult.public_fetch).status_code ?? "")} fetch_ok=${String(Boolean(checks.public_fetch_ok))}`,
      },
    ],
    publicObservation: {
      observedAt: firstNonEmptyString(legacyResult.verified_at, new Date().toISOString()),
      url: firstNonEmptyString(legacyResult.link, publish.url, run.targetSite),
      fetchStatus: publicVisibilityPass ? "reachable" : "missing",
      httpStatus: Number(toRecord(legacyResult.public_fetch).status_code ?? 0) || (publicVisibilityPass ? 200 : 404),
      publishStatus: publicVisibilityPass ? observedPublishStatus : "missing",
      featuredMediaPresent: observedFeaturedMediaPresent,
      featuredMediaLabel: observedFeaturedMediaPresent
        ? firstNonEmptyString(toRecord(publish.featured_media).title, featuredMediaLabel)
        : null,
      headline: publicVisibilityPass ? firstNonEmptyString(legacyResult.title, draft.title, run.topic) : null,
      decisionState: publicDecisionState,
      decisionSummary: readerDecisionPass
        ? "The observed page still supports the approved reader decision."
        : "The observed page does not support a reliable reader decision.",
      summary: verdict === "pass"
        ? "Public verify matched the approved article and Publisher expectations."
        : "Public verify detected a mismatch between the approved article and the observed public page.",
    },
    driftSummary: {
      class: driftClass,
      summary: verdict === "pass"
        ? "No contract-level drift was detected."
        : `Drift detected in ${driftClass}.`,
    },
    overrideSummary: {
      applied: [],
      blocked: failureNames.map((name) => `${name} is non-overrideable`),
    },
    ok: verdict === "pass",
    mode: legacyResult.mode ?? "wordpress",
  };
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
          {
            const publicVerifyContractMode = resolvePublicVerifyContractMode(run, deps.publicVerifyContractMode);
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
          if (String(run.publishMode ?? "draft") !== "dry_run" && !isSharedPublicVerifyPayload(result)) {
            if (publicVerifyContractMode === "strict") {
              throw new Error("blog_run_public_verify_contract_missing");
            }
            result = await normalizeLegacyPublicVerifyResult(run, runDir, toRecord(result));
          }
          if (!isPublicVerifyPass(result)) {
            throw new Error(publicVerifyFailureMessage(result));
          }
          break;
          }
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
