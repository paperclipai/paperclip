import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "/Users/daehan/Documents/persona/paperclip/node_modules/.pnpm/node_modules/drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  blogPublishExecutions,
  blogRuns,
  companies,
  projects,
} from "/Users/daehan/Documents/persona/paperclip/packages/db/src/index.ts";
import { blogArtifactMirrorService } from "/Users/daehan/Documents/persona/paperclip/server/src/services/blog-artifact-mirror.ts";
import { blogPublisherService } from "/Users/daehan/Documents/persona/paperclip/server/src/services/blog-publisher.ts";
import { blogRunService } from "/Users/daehan/Documents/persona/paperclip/server/src/services/blog-runs.ts";
import { blogRunWorkerService } from "/Users/daehan/Documents/persona/paperclip/server/src/services/blog-run-worker.ts";

function createJsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function createSharedVerifyResult(verdict: "pass" | "fail" = "pass") {
  const failureNames = verdict === "fail" ? ["PUBLIC_VERIFY_REGRESSION"] : [];
  return {
    schemaVersion: "shared-public-verify.v1",
    verifyId: "verify-1",
    approvedArtifactRef: {
      issueIdentifier: "FLU-CANARY",
      artifactId: "artifact-1",
      artifactLabel: "Approved article",
    },
    approvedArtifact: {
      issueIdentifier: "FLU-CANARY",
      artifactId: "artifact-1",
      artifactLabel: "Approved article",
      headline: "Live canary title",
      decisionState: "adopt",
      decisionSummary: "Approved package expected a decision-ready article.",
      requiredSections: ["verdict_overview", "evidence_breakdown", "who_should_adopt"],
    },
    publisherExpectations: {
      headline: "Live canary title",
      decisionState: "adopt",
      decisionSummary: "Publisher expected a decision-ready article.",
      publishStatus: "publish",
      featuredMedia: {
        required: false,
        label: "No featured image required",
      },
    },
    publishReceiptId: "receipt-1",
    publishReceiptLabel: "Receipt 1",
    publishReceipt: {
      receiptId: "receipt-1",
      label: "Receipt 1",
      mode: "live-run",
      lifecycle: "executed",
      target: "wordpress.production",
      targetUrl: "https://fluxaivory.com/live-canary/",
      publishedAt: "2026-04-05T09:00:00.000Z",
    },
    publicUrl: "https://fluxaivory.com/live-canary/",
    verifiedAt: "2026-04-05T09:01:00.000Z",
    verdict,
    readerDecisionState: "adopt",
    readerDecisionSummary: "Reader can reach a clear adopt decision.",
    coreChecks: [
      { checkId: "public_visibility", status: "pass", overrideable: false, summary: "Visibility check." },
      { checkId: "title_framing", status: "pass", overrideable: false, summary: "Title framing check." },
      { checkId: "body_contract", status: "pass", overrideable: false, summary: "Body contract check." },
      { checkId: "media_and_status", status: "pass", overrideable: false, summary: "Media and status check." },
      { checkId: "artifact_parity", status: "pass", overrideable: false, summary: "Artifact parity check." },
      { checkId: "reader_decision", status: "pass", overrideable: false, summary: "Reader decision check." },
    ],
    failureNames,
    warnings: [],
    evidence: [
      { surface: "approved_package", signal: "approved article present" },
      { surface: "publication_receipt", signal: "publish receipt present" },
      { surface: "public_verify", signal: "public verify evidence present" },
    ],
    publicObservation: {
      observedAt: "2026-04-05T09:01:00.000Z",
      url: "https://fluxaivory.com/live-canary/",
      fetchStatus: "reachable",
      httpStatus: 200,
      publishStatus: "publish",
      featuredMediaPresent: false,
      featuredMediaLabel: null,
      headline: "Live canary title",
      decisionState: "adopt",
      decisionSummary: "Reader can still adopt.",
      summary: "Public page matched expectations.",
    },
    driftSummary: {
      class: "none",
      summary: "No drift.",
    },
    overrideSummary: {
      applied: [],
      blocked: [],
    },
  };
}

async function main() {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) {
    throw new Error("embedded_postgres_not_supported");
  }

  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blog-publish-canary-");
  const db = createDb(tempDb.connectionString);
  const scratchRoot = await blogArtifactMirrorService().createScratchRoot();

  try {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Canary",
      issuePrefix: `PC${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Blog pipeline canary",
      status: "in_progress",
    });

    const mirror = blogArtifactMirrorService({ baseDir: scratchRoot });
    const runSvc = blogRunService(db, { artifactMirror: mirror });
    const fetchImpl = async (...args: unknown[]) => {
      const [url, init] = args as [string, RequestInit | undefined];
      if (String(url).includes("/users/me")) {
        return createJsonResponse(200, { id: 7, name: "Local Admin", slug: "localadmin" });
      }
      if (String(url).includes("/posts") && String(init?.method || "POST").toUpperCase() === "POST") {
        return createJsonResponse(201, { id: 980, status: "publish", link: "https://fluxaivory.com/live-canary/" });
      }
      return createJsonResponse(200, {});
    };
    const publisher = blogPublisherService(db, {
      fetchImpl,
      env: {
        WP_API_URL: "https://fluxaivory.com/wp-json/wp/v2",
        WP_USER: "localadmin",
        WP_APP_PASSWORD: "app-pass",
      },
    });
    const worker = blogRunWorkerService(db, {
      runService: runSvc,
      artifactRoot: scratchRoot,
      publisher,
      runGrokArtifactStep: async () => ({ ok: true, source: "grok-web-artifact-step" }),
      runResearchStep: async () => ({ summary: "research ok" }),
      runDraftStep: async () => ({
        title: "Live canary title",
        article_html: "<p>Live canary body</p>",
      }),
      runImageStep: async () => ({
        featured: { sha256: "a" },
        supporting: [
          { kind: "structured_fallback", role: "comparison", heading: "핵심 비교 정리" },
          { kind: "structured_fallback", role: "workflow", heading: "도입 흐름 한눈에 보기" },
        ],
        structured_fallback_used: true,
      }),
      runDraftReviewStep: async () => ({ verdict: "pass" }),
      runDraftPolishStep: async () => ({ verdict: "pass" }),
      runFinalReviewStep: async () => ({ verdict: "approve" }),
      runValidateStep: async () => ({ ok: true }),
      runPublicVerifyStep: async () => createSharedVerifyResult("pass"),
      runQualityGateBundle: async () => ({
        results: {
          publish_ready: {
            ok: true,
            status: "pass",
            failed_gates: [],
            summary: "all publish-ready gates passed",
          },
        },
      }),
    });

    const run = await runSvc.create({
      companyId,
      projectId,
      topic: "Live canary topic",
      lane: "publish",
      publishMode: "publish",
      contextJson: {
        title: "Live canary title",
        article_html: "<p>Live canary body</p>",
        publishReadyGateCanary: true,
      },
    });

    if (!run?.id) {
      throw new Error("publish_canary_run_create_failed");
    }

    for (let i = 0; i < 7; i += 1) {
      await worker.runNext(run.id);
    }

    let detail = await runSvc.getDetail(run.id);
    if (detail?.run.status !== "publish_approval_pending") {
      throw new Error(`publish_canary_expected_publish_approval_pending:${detail?.run.status}`);
    }

    await runSvc.requestPublishApproval(run.id, {
      targetSlug: "live-canary-title",
      artifactHash: "artifact-hash",
      normalizedDomHash: "dom-hash",
      approvalKeyHash: "approval-hash",
      publishIdempotencyKey: "publish-key-live-canary",
      approvedByUserId: "operator",
    });

    await worker.runNext(run.id);
    await worker.runNext(run.id);

    detail = await runSvc.getDetail(run.id);
    const publishRows = await db.select().from(blogPublishExecutions);
    const publishResult = JSON.parse(await fs.readFile(path.join(scratchRoot, run.id, "publish.json"), "utf8"));
    const verifyResult = JSON.parse(await fs.readFile(path.join(scratchRoot, run.id, "verify.json"), "utf8"));

    console.log(JSON.stringify({
      ok: true,
      runId: run.id,
      finalStatus: detail?.run.status ?? null,
      wordpressPostId: detail?.run.wordpressPostId ?? null,
      publishedUrl: detail?.run.publishedUrl ?? null,
      publishExecutionCount: publishRows.length,
      publishResult: {
        postId: publishResult.postId ?? null,
        url: publishResult.url ?? null,
      },
      verifyResult: {
        schemaVersion: verifyResult.schemaVersion ?? null,
        verdict: verifyResult.verdict ?? null,
      },
    }, null, 2));
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
    await tempDb.cleanup();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
