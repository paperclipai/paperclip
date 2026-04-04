import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { blogRunWorkerService } from "../services/blog-run-worker.ts";

function createSharedVerifyResult(
  verdict: "pass" | "fail" = "pass",
  overrides: Record<string, unknown> = {},
) {
  const failureNames = verdict === "fail" ? ["PUBLIC_VERIFY_REGRESSION"] : [];
  return {
    schemaVersion: "shared-public-verify.v1",
    verifyId: "verify-1",
    approvedArtifactRef: {
      issueIdentifier: "FLU-45",
      artifactId: "artifact-1",
      artifactLabel: "Approved article",
    },
    approvedArtifact: {
      issueIdentifier: "FLU-45",
      artifactId: "artifact-1",
      artifactLabel: "Approved article",
      headline: "Test title",
      decisionState: verdict === "pass" ? "adopt" : "unclear",
      decisionSummary: "Approved package expectation.",
      requiredSections: ["verdict_overview", "evidence_breakdown", "who_should_adopt"],
    },
    publisherExpectations: {
      headline: "Test title",
      decisionState: verdict === "pass" ? "adopt" : "unclear",
      decisionSummary: "Publisher expected a clear decision path.",
      publishStatus: "publish",
      featuredMedia: {
        required: true,
        label: "Hero image",
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
      targetUrl: "https://fluxaivory.com/test/",
      publishedAt: "2026-04-04T10:00:00.000Z",
    },
    publicUrl: "https://fluxaivory.com/test/",
    verifiedAt: "2026-04-04T10:01:00.000Z",
    verdict,
    readerDecisionState: verdict === "pass" ? "adopt" : "unclear",
    readerDecisionSummary: verdict === "pass"
      ? "Reader can reach an adopt decision."
      : "Reader cannot reach a safe decision.",
    coreChecks: [
      { checkId: "public_visibility", status: verdict === "pass" ? "pass" : "fail", overrideable: false, summary: "Visibility check." },
      { checkId: "title_framing", status: "pass", overrideable: false, summary: "Title framing check." },
      { checkId: "body_contract", status: "pass", overrideable: false, summary: "Body contract check." },
      { checkId: "media_and_status", status: verdict === "pass" ? "pass" : "fail", overrideable: false, summary: "Media and status check." },
      { checkId: "artifact_parity", status: verdict === "pass" ? "pass" : "fail", overrideable: false, summary: "Artifact parity check." },
      { checkId: "reader_decision", status: verdict === "pass" ? "pass" : "fail", overrideable: false, summary: "Reader decision check." },
    ],
    failureNames,
    warnings: [],
    evidence: [
      { surface: "approved_package", signal: "approved article present" },
      { surface: "publication_receipt", signal: "publish receipt present" },
      { surface: "public_verify", signal: "public verify evidence present" },
    ],
    publicObservation: {
      observedAt: "2026-04-04T10:01:00.000Z",
      url: "https://fluxaivory.com/test/",
      fetchStatus: verdict === "pass" ? "reachable" : "missing",
      httpStatus: verdict === "pass" ? 200 : 404,
      publishStatus: verdict === "pass" ? "publish" : "missing",
      featuredMediaPresent: verdict === "pass",
      featuredMediaLabel: verdict === "pass" ? "Hero image" : null,
      headline: verdict === "pass" ? "Test title" : null,
      decisionState: verdict === "pass" ? "adopt" : "unclear",
      decisionSummary: verdict === "pass" ? "Reader can still adopt." : "Reader cannot evaluate the page.",
      summary: verdict === "pass" ? "Public page matched expectations." : "Public page was missing.",
    },
    driftSummary: {
      class: verdict === "pass" ? "none" : "public_visibility",
      summary: verdict === "pass" ? "No drift." : "Public article never became reachable.",
    },
    overrideSummary: {
      applied: [],
      blocked: verdict === "pass" ? [] : ["PUBLIC_VERIFY_REGRESSION is non-overrideable"],
    },
    ...overrides,
  };
}

function createRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    companyId: "company-1",
    topic: "Test topic",
    lane: "publish",
    targetSite: "fluxaivory.com",
    currentStep: "research",
    status: "queued",
    publishMode: "draft",
    contextJson: {
      title: "Test title",
      article_html: "<p>Body</p>",
    },
    ...overrides,
  };
}

function createClaim(runOverrides: Record<string, unknown> = {}, attemptOverrides: Record<string, unknown> = {}) {
  return {
    run: createRun(runOverrides),
    attempt: {
      id: "attempt-1",
      stepKey: "research",
      ...attemptOverrides,
    },
  };
}

describe("blog run worker", () => {
  it("runs a normal content step and completes it", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun()),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim()),
      completeStep: vi.fn().mockResolvedValue({ run: { status: "research_ready", currentStep: "draft" } }),
      failStep: vi.fn(),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      runResearchStep: vi.fn().mockResolvedValue({ research: "ok" }),
    });

    const result = await worker.runNext("run-1");

    expect(runService.claimNextStep).toHaveBeenCalledWith("run-1");
    expect(runService.completeStep).toHaveBeenCalledWith("run-1", "research", expect.objectContaining({
      attemptId: "attempt-1",
      resultJson: { research: "ok" },
    }));
    expect(runService.failStep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ run: { status: "research_ready" } });
  });

  it("fails the run when validate returns ok=false", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({ currentStep: "validate" })),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim({ currentStep: "validate" }, { stepKey: "validate" })),
      completeStep: vi.fn(),
      failStep: vi.fn().mockResolvedValue({ run: { status: "failed", failedReason: "blog_run_validation_failed" } }),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      runValidateStep: vi.fn().mockResolvedValue({ ok: false, failures: ["x"] }),
    });

    const result = await worker.runNext("run-1");

    expect(runService.completeStep).not.toHaveBeenCalled();
    expect(runService.failStep).toHaveBeenCalledWith("run-1", "validate", expect.objectContaining({
      attemptId: "attempt-1",
      errorMessage: "blog_run_validation_failed",
    }));
    expect(result).toMatchObject({ run: { status: "failed" } });
  });

  it("blocks report lane from publishing", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({ lane: "report", currentStep: "publish", approvalId: "approval-1", publishIdempotencyKey: "idem-1" })),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim({ lane: "report", currentStep: "publish", approvalId: "approval-1", publishIdempotencyKey: "idem-1" }, { stepKey: "publish" })),
      completeStep: vi.fn(),
      failStep: vi.fn().mockResolvedValue({ run: { status: "failed", failedReason: "wordpress_write_forbidden:report_lane" } }),
    };
    const publisher = {
      publishDraft: vi.fn(),
      publishPost: vi.fn(),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      publisher: publisher as any,
    });

    await worker.runNext("run-1");

    expect(publisher.publishDraft).not.toHaveBeenCalled();
    expect(runService.failStep).toHaveBeenCalledWith("run-1", "publish", expect.objectContaining({
      errorMessage: "wordpress_write_forbidden:report_lane",
    }));
  });

  it("uses the publisher boundary for publish steps", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({
        currentStep: "publish",
        approvalId: "approval-1",
        publishIdempotencyKey: "idem-1",
      })),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim({
        currentStep: "publish",
        approvalId: "approval-1",
        publishIdempotencyKey: "idem-1",
      }, { stepKey: "publish" })),
      completeStep: vi.fn().mockResolvedValue({ run: { status: "published", currentStep: "public_verify" } }),
      failStep: vi.fn(),
    };
    const publisher = {
      publishDraft: vi.fn().mockResolvedValue({
        reusedExecution: false,
        authenticatedUser: "Local Admin",
        post: { id: 123, status: "draft", link: "https://fluxaivory.com/test/" },
        featuredMedia: null,
        supportingMedia: [],
      }),
      publishPost: vi.fn(),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      publisher: publisher as any,
    });

    await worker.runNext("run-1");

    expect(publisher.publishDraft).toHaveBeenCalledWith(expect.objectContaining({
      blogRunId: "run-1",
      approvalId: "approval-1",
      publishIdempotencyKey: "idem-1",
    }));
    expect(runService.completeStep).toHaveBeenCalledWith("run-1", "publish", expect.objectContaining({
      resultJson: expect.objectContaining({
        postId: 123,
        url: "https://fluxaivory.com/test/",
      }),
    }));
  });

  it("runs public verify and completes the terminal step", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({ currentStep: "public_verify", status: "published" })),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim({ currentStep: "public_verify", status: "published" }, { stepKey: "public_verify" })),
      completeStep: vi.fn().mockResolvedValue({ run: { status: "public_verified", currentStep: null } }),
      failStep: vi.fn(),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      runPublicVerifyStep: vi.fn().mockResolvedValue(createSharedVerifyResult("pass")),
    });

    const result = await worker.runNext("run-1");

    expect(runService.completeStep).toHaveBeenCalledWith("run-1", "public_verify", expect.objectContaining({
      resultJson: expect.objectContaining({
        schemaVersion: "shared-public-verify.v1",
        verdict: "pass",
      }),
    }));
    expect(result).toMatchObject({ run: { status: "public_verified" } });
  });

  it("fails the run when shared public verify verdict is fail even without ok=false", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({ currentStep: "public_verify", status: "published" })),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim({ currentStep: "public_verify", status: "published" }, { stepKey: "public_verify" })),
      completeStep: vi.fn(),
      failStep: vi.fn().mockResolvedValue({ run: { status: "failed", failedReason: "blog_run_public_verify_failed:PUBLIC_VERIFY_REGRESSION" } }),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      runPublicVerifyStep: vi.fn().mockResolvedValue(createSharedVerifyResult("fail")),
    });

    const result = await worker.runNext("run-1");

    expect(runService.completeStep).not.toHaveBeenCalled();
    expect(runService.failStep).toHaveBeenCalledWith("run-1", "public_verify", expect.objectContaining({
      errorMessage: "blog_run_public_verify_failed:PUBLIC_VERIFY_REGRESSION",
    }));
    expect(result).toMatchObject({ run: { status: "failed" } });
  });

  it("normalizes legacy public verify payloads into the shared contract surface", async () => {
    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-blog-run-worker-"));
    const runDir = path.join(artifactRoot, "run-1");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "draft.json"), JSON.stringify({
      title: "Legacy verify title",
      article_html: "<h2>지금 써볼지 말지 판단 기준</h2><p>지금 바로 한 번 가볍게 시험해볼 만합니다.</p>",
      decisionState: "adopt",
      decisionSummary: "Approved draft expects an adopt recommendation.",
    }, null, 2));
    await fs.writeFile(path.join(runDir, "publish.json"), JSON.stringify({
      ok: true,
      mode: "wordpress",
      generated_at: "2026-04-04T10:00:00.000Z",
      post_id: 123,
      status: "publish",
      url: "https://fluxaivory.com/test/",
      featured_media: null,
    }, null, 2));

    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({
        currentStep: "public_verify",
        status: "published",
        publishMode: "publish",
        contextJson: {
          title: "Legacy verify title",
          article_html: "<p>Body</p>",
        },
      })),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim({ currentStep: "public_verify", status: "published", publishMode: "publish" }, { stepKey: "public_verify" })),
      completeStep: vi.fn().mockResolvedValue({ run: { status: "public_verified", currentStep: null } }),
      failStep: vi.fn(),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      artifactRoot,
      runPublicVerifyStep: vi.fn().mockResolvedValue({
        ok: true,
        mode: "wordpress",
        verified_at: "2026-04-04T10:01:00.000Z",
        post_id: 123,
        status: "publish",
        slug: "test",
        link: "https://fluxaivory.com/test/",
        title: "Legacy verify title",
        featured_media_id: 0,
        featured_media_url: null,
        public_fetch: {
          status_code: 200,
          content_type: "text/html",
          expected_for_status: "2xx_or_3xx_public",
        },
        checks: {
          post_found: true,
          status_matches: true,
          link_present: true,
          title_matches: true,
          featured_media_attached: false,
          public_fetch_ok: true,
          public_contains_title: true,
          public_contains_featured_url: null,
        },
      }),
    });

    await worker.runNext("run-1");

    expect(runService.failStep).not.toHaveBeenCalled();
    expect(runService.completeStep).toHaveBeenCalledWith("run-1", "public_verify", expect.objectContaining({
      resultJson: expect.objectContaining({
        schemaVersion: "shared-public-verify.v1",
        verdict: "pass",
        publisherExpectations: expect.objectContaining({
          publishStatus: "publish",
        }),
        publicObservation: expect.objectContaining({
          publishStatus: "publish",
          featuredMediaPresent: false,
        }),
      }),
    }));

    await fs.rm(artifactRoot, { recursive: true, force: true });
  });

  it("fails closed in strict mode when public verify does not return the shared contract", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({ currentStep: "public_verify", status: "published", publishMode: "publish" })),
      getDetail: vi.fn().mockResolvedValue({ ok: true }),
      claimNextStep: vi.fn().mockResolvedValue(createClaim({ currentStep: "public_verify", status: "published", publishMode: "publish" }, { stepKey: "public_verify" })),
      completeStep: vi.fn(),
      failStep: vi.fn().mockResolvedValue({ run: { status: "failed", failedReason: "blog_run_public_verify_contract_missing" } }),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
      publicVerifyContractMode: "strict",
      runPublicVerifyStep: vi.fn().mockResolvedValue({
        ok: true,
        mode: "wordpress",
        post_id: 123,
        status: "publish",
        link: "https://fluxaivory.com/test/",
        checks: { post_found: true },
      }),
    });

    const result = await worker.runNext("run-1");

    expect(runService.completeStep).not.toHaveBeenCalled();
    expect(runService.failStep).toHaveBeenCalledWith("run-1", "public_verify", expect.objectContaining({
      errorMessage: "blog_run_public_verify_contract_missing",
    }));
    expect(result).toMatchObject({ run: { status: "failed" } });
  });

  it("refuses to run publish while approval is pending", async () => {
    const runService = {
      getById: vi.fn().mockResolvedValue(createRun({ currentStep: "publish", status: "publish_approval_pending" })),
      getDetail: vi.fn(),
      claimNextStep: vi.fn(),
      completeStep: vi.fn(),
      failStep: vi.fn(),
    };
    const worker = blogRunWorkerService({} as any, {
      runService: runService as any,
    });

    await expect(worker.runNext("run-1")).rejects.toThrow("Publish approval is required before running publish");
    expect(runService.claimNextStep).not.toHaveBeenCalled();
  });
});
