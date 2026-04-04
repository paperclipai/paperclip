import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("blog artifact mirror integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let scratchRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blog-artifact-mirror-");
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
    const companyId = "22222222-2222-4222-8222-222222222222";
    const projectId = "33333333-3333-4333-8333-333333333333";
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
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

  it("writes context, status, step result, and artifact mirror files", async () => {
    const { companyId, projectId } = await seedProject();
    const mirror = blogArtifactMirrorService({ baseDir: scratchRoot });
    const svc = blogRunService(db, { artifactMirror: mirror });

    const created = await svc.create({
      companyId,
      projectId,
      topic: "Mirror test topic",
      lane: "publish",
      contextJson: {
        title: "Mirror title",
      },
    });

    const contextPath = path.join(scratchRoot, created!.id, "context.json");
    const statusPath = path.join(scratchRoot, created!.id, "status.json");
    expect(JSON.parse(await fs.readFile(contextPath, "utf8"))).toMatchObject({
      run_id: created!.id,
      topic: "Mirror test topic",
      title: "Mirror title",
    });
    expect(JSON.parse(await fs.readFile(statusPath, "utf8"))).toMatchObject({
      phase: "research",
      state: "running",
      next_step: "research",
    });

    const claim = await svc.claimNextStep(created!.id);
    await svc.completeStep(created!.id, "research", {
      attemptId: claim!.attempt!.id,
      resultJson: { bundlePath: "/tmp/research.json" },
      artifacts: [{
        artifactKind: "research_json",
        contentType: "application/json",
        storagePath: "/tmp/research.json",
      }],
    });

    const researchPath = path.join(scratchRoot, created!.id, "research.json");
    const artifactsPath = path.join(scratchRoot, created!.id, "artifacts.research.json");
    const updatedStatus = JSON.parse(await fs.readFile(statusPath, "utf8"));

    expect(JSON.parse(await fs.readFile(researchPath, "utf8"))).toMatchObject({
      bundlePath: "/tmp/research.json",
    });
    expect(JSON.parse(await fs.readFile(artifactsPath, "utf8"))).toEqual([
      expect.objectContaining({
        artifactKind: "research_json",
        storagePath: "/tmp/research.json",
      }),
    ]);
    expect(updatedStatus).toMatchObject({
      phase: "draft",
      state: "running",
      last_completed_step: "research",
      next_step: "draft",
    });
  });

  it("writes a structured stop reason for automatic stop and follow-up failures", async () => {
    const { companyId, projectId } = await seedProject();
    const mirror = blogArtifactMirrorService({ baseDir: scratchRoot });
    const svc = blogRunService(db, { artifactMirror: mirror });

    const publishRun = await svc.create({
      companyId,
      projectId,
      topic: "Publish verify failure",
      lane: "publish",
      publishMode: "publish",
    });
    const publishClaim = await svc.claimNextStep(publishRun!.id);
    await svc.failStep(publishRun!.id, "research", {
      attemptId: publishClaim!.attempt!.id,
      errorCode: "BLOG_RUN_PUBLIC_VERIFY_FAILED",
      errorMessage: "blog_run_public_verify_failed:PUBLIC_VERIFY_REGRESSION",
    });

    const publishStatus = JSON.parse(await fs.readFile(path.join(scratchRoot, publishRun!.id, "status.json"), "utf8"));
    const publishStopReason = JSON.parse(await fs.readFile(path.join(scratchRoot, publishRun!.id, "stop-reason.json"), "utf8"));

    expect(publishStatus.stop_reason).toMatchObject({
      failureName: "PUBLIC_VERIFY_FAILURE",
      classification: "auto_stop",
      stopScope: "article",
      stopActive: true,
      primaryOwner: "publish-verify",
    });
    expect(publishStopReason).toMatchObject({
      failureName: "PUBLIC_VERIFY_FAILURE",
      classification: "auto_stop",
      resumeRequirements: ["passing public verify verdict on the corrected or quarantined state"],
    });

    const draftRun = await svc.create({
      companyId,
      projectId,
      topic: "Research wobble",
      lane: "publish",
      publishMode: "draft",
    });
    const draftClaim = await svc.claimNextStep(draftRun!.id);
    await svc.failStep(draftRun!.id, "research", {
      attemptId: draftClaim!.attempt!.id,
      errorCode: "RESEARCH_ERROR",
      errorMessage: "research_bundle_missing",
    });

    const draftStatus = JSON.parse(await fs.readFile(path.join(scratchRoot, draftRun!.id, "status.json"), "utf8"));
    const draftStopReason = JSON.parse(await fs.readFile(path.join(scratchRoot, draftRun!.id, "stop-reason.json"), "utf8"));

    expect(draftStatus.stop_reason).toMatchObject({
      failureName: "RESEARCH_QUALITY_WOBBLE",
      classification: "follow_up",
      stopScope: "article",
      stopActive: false,
      primaryOwner: "research-draft",
    });
    expect(draftStopReason).toMatchObject({
      failureName: "RESEARCH_QUALITY_WOBBLE",
      classification: "follow_up",
      nextAction: "repair the article or explicitly reject the run",
    });
  });
});
