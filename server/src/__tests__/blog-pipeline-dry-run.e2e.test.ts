import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  blogArtifacts,
  blogPublishApprovals,
  blogPublishExecutions,
  blogRunStepAttempts,
  blogRuns,
  companies,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { blogArtifactMirrorService } from "../services/blog-artifact-mirror.ts";
import { blogRunService } from "../services/blog-runs.ts";
import { blogRunWorkerService } from "../services/blog-run-worker.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("blog pipeline dry-run e2e", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let scratchRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blog-dry-run-e2e-");
    db = createDb(tempDb.connectionString);
    scratchRoot = await blogArtifactMirrorService().createScratchRoot();
  }, 20_000);

  afterEach(async () => {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
    scratchRoot = await blogArtifactMirrorService().createScratchRoot();
    await db.delete(blogPublishExecutions);
    await db.delete(blogPublishApprovals);
    await db.delete(blogArtifacts);
    await db.delete(blogRunStepAttempts);
    await db.delete(blogRuns);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
    await tempDb?.cleanup();
  });

  async function seedProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Blog pipeline",
      status: "in_progress",
    });
    return { companyId, projectId };
  }

  it("runs the full dry-run graph, mirrors artifacts, and avoids WordPress writes", async () => {
    const { companyId, projectId } = await seedProject();
    const mirror = blogArtifactMirrorService({ baseDir: scratchRoot });
    const runSvc = blogRunService(db, { artifactMirror: mirror });
    const publisher = {
      publishDraft: vi.fn(),
      publishPost: vi.fn(),
    };
    const worker = blogRunWorkerService(db, {
      runService: runSvc,
      artifactRoot: scratchRoot,
      publisher: publisher as any,
      runResearchStep: vi.fn().mockResolvedValue({ summary: "research ok", sources: 4 }),
      runDraftStep: vi.fn().mockResolvedValue({
        title: "Dry run title",
        article_html: "<p>Dry run body</p>",
      }),
      runImageStep: vi.fn().mockResolvedValue({ saved_path: "/tmp/featured.png" }),
      runDraftReviewStep: vi.fn().mockResolvedValue({ verdict: "pass" }),
      runDraftPolishStep: vi.fn().mockResolvedValue({ verdict: "pass" }),
      runFinalReviewStep: vi.fn().mockResolvedValue({ verdict: "approve" }),
      runValidateStep: vi.fn().mockResolvedValue({ ok: true }),
      runPublicVerifyStep: vi.fn(),
    });

    const run = await runSvc.create({
      companyId,
      projectId,
      topic: "Dry run topic",
      lane: "publish",
      publishMode: "dry_run",
      contextJson: {
        title: "Dry run title",
        article_html: "<p>Dry run body</p>",
      },
    });

    for (let i = 0; i < 9; i += 1) {
      const current = await runSvc.getById(run!.id);
      if (!current?.currentStep) break;
      await worker.runNext(run!.id);
    }

    const finalDetail = await runSvc.getDetail(run!.id);
    expect(finalDetail?.run.status).toBe("public_verified");
    expect(finalDetail?.run.currentStep).toBeNull();
    expect(publisher.publishDraft).not.toHaveBeenCalled();
    expect(publisher.publishPost).not.toHaveBeenCalled();

    const runDir = path.join(scratchRoot, run!.id);
    const requiredFiles = [
      "context.json",
      "status.json",
      "research.json",
      "draft.json",
      "draft.md",
      "image.json",
      "draft.review.json",
      "draft.polish.json",
      "draft.final-review.json",
      "validation.json",
      "publish.json",
      "verify.json",
    ];
    for (const file of requiredFiles) {
      await expect(fs.stat(path.join(runDir, file))).resolves.toBeTruthy();
    }

    const publishResult = JSON.parse(await fs.readFile(path.join(runDir, "publish.json"), "utf8"));
    const verifyResult = JSON.parse(await fs.readFile(path.join(runDir, "verify.json"), "utf8"));
    const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));

    expect(publishResult).toMatchObject({
      mode: "dry-run",
      payloadPreview: {
        title: "Dry run title",
      },
    });
    expect(verifyResult).toMatchObject({
      ok: true,
      mode: "dry-run",
    });
    expect(status).toMatchObject({
      phase: "public_verify",
      state: "completed",
      last_completed_step: "public_verify",
      next_step: null,
    });
  });

  it("fails dry-run validate when strict publish-ready canary returns a failed merged preflight", async () => {
    const { companyId, projectId } = await seedProject();
    const mirror = blogArtifactMirrorService({ baseDir: scratchRoot });
    const runSvc = blogRunService(db, { artifactMirror: mirror });
    const worker = blogRunWorkerService(db, {
      runService: runSvc,
      artifactRoot: scratchRoot,
      publisher: { publishDraft: vi.fn(), publishPost: vi.fn() } as any,
      runResearchStep: vi.fn().mockResolvedValue({ summary: "research ok", notebook_reference: "n1", fact_pack: { items: [1] }, source_registry: [{ url: "https://example.com" }], uncertainty_ledger: [{ claim: "x" }] }),
      runDraftStep: vi.fn().mockResolvedValue({
        title: "Dry run title",
        article_html: "<p>Dry run body</p>",
        markdown: "## 목차\n\n이번 글에서 볼 3가지\n\nbody\n\n지금 써볼 사람과 기다릴 사람을 판단한다.",
        sections: [{ title: "변화 1" }, { title: "변화 2" }, { title: "변화 3" }],
        ending_judgment: "지금 써볼 사람과 기다릴 사람을 판단한다.",
      }),
      runImageStep: vi.fn().mockResolvedValue({
        featured: { sha256: "a" },
        "support-1": { sha256: "b", role: "comparison" },
        "support-2": { sha256: "c", role: "workflow" },
      }),
      runDraftReviewStep: vi.fn().mockResolvedValue({ verdict: "pass" }),
      runDraftPolishStep: vi.fn().mockResolvedValue({ verdict: "pass" }),
      runFinalReviewStep: vi.fn().mockResolvedValue({ verdict: "approve" }),
      runValidateStep: vi.fn().mockResolvedValue({ ok: true }),
      runQualityGateBundle: vi.fn().mockResolvedValue({
        results: {
          publish_ready: {
            ok: false,
            status: "fail",
            failed_gates: ["visual_quality"],
          },
        },
      }),
    });

    const run = await runSvc.create({
      companyId,
      projectId,
      topic: "Dry run canary topic",
      lane: "publish",
      publishMode: "dry_run",
      contextJson: {
        title: "Dry run title",
        article_html: "<p>Dry run body</p>",
        publishReadyGateCanary: true,
      },
    });

    for (let i = 0; i < 7; i += 1) {
      const current = await runSvc.getById(run!.id);
      if (!current?.currentStep) break;
      await worker.runNext(run!.id);
    }

    const finalDetail = await runSvc.getDetail(run!.id);
    expect(finalDetail?.run.status).toBe("failed");
    expect(finalDetail?.run.failedReason).toBe("blog_run_publish_ready_failed:visual_quality");
  });
});
