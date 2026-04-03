import { describe, expect, it, vi } from "vitest";
import { blogRunWorkerService } from "../services/blog-run-worker.ts";

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
      runPublicVerifyStep: vi.fn().mockResolvedValue({ ok: true, checks: { post_found: true } }),
    });

    const result = await worker.runNext("run-1");

    expect(runService.completeStep).toHaveBeenCalledWith("run-1", "public_verify", expect.objectContaining({
      resultJson: { ok: true, checks: { post_found: true } },
    }));
    expect(result).toMatchObject({ run: { status: "public_verified" } });
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
