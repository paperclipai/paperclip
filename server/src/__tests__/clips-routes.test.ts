import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clipRoutes } from "../routes/clips.js";
import { errorHandler } from "../middleware/index.js";

const mockClipService = vi.hoisted(() => ({
  getPublicDetail: vi.fn(),
  getPublicRevision: vi.fn(),
  getCreatorPublicProfile: vi.fn(),
  publish: vi.fn(),
  getClipById: vi.fn(),
  createRevision: vi.fn(),
  updateClip: vi.fn(),
  createVote: vi.fn(),
  createReport: vi.fn(),
  createComment: vi.fn(),
  createShowcase: vi.fn(),
  recordImportTelemetry: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/clips.js", () => ({
  clipService: () => mockClipService,
}));

vi.mock("../services/index.js", () => ({
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  logActivity: mockLogActivity,
}));


const HASH = "sha256:" + "0".repeat(64);

function importableManifest(slug = "support-triage") {
  return {
    schema: "paperclip.clip/v1",
    clip: {
      id: "clip_1",
      slug,
      type: "bundle",
      revisionId: "cliprev_1",
      revisionNumber: 1,
      manifestVersion: 1,
      title: "Support Triage",
      summary: "Routes support tickets.",
      visibility: "public",
      creator: null,
    },
    publication: {
      source: {
        kind: "paperclip_company_object",
        objectType: "bundle",
        exportedAt: "2026-05-16T00:00:00.000Z",
      },
      compatibility: {
        paperclip: null,
        manifest: "agentcompanies/v1-draft",
      },
    },
    artifact: {
      format: "agentcompanies",
      version: "agentcompanies/v1-draft",
      checksum: HASH,
      entrypoint: "COMPANY.md",
      paperclipExtension: ".paperclip.yaml",
      payload: {
        manifest: { schemaVersion: 1 },
        files: { "COMPANY.md": "# Support Triage" },
      },
    },
    dependencies: {
      adapters: [],
      plugins: [],
      skills: [],
      secrets: [],
      permissions: [],
      runtime: {
        localShell: false,
        browser: false,
        filesystem: "none",
        webhooks: false,
        recurringRoutines: false,
      },
      workspaces: [],
      budgetHints: { monthlyCents: 0, sourceRefs: [] },
    },
    security: {
      redactionReport: {
        schema: "paperclip.clip.redaction/v1",
        generatedAt: "2026-05-16T00:00:00.000Z",
        entries: [],
        summary: { allowed: 0, redacted: 0, summarized: 0, omitted: 0 },
      },
      dangerousCapabilities: [],
      routinePolicy: {
        importedTriggersEnabledByDefault: false,
        webhookSecretsRegenerated: true,
      },
      reviewState: "unreviewed",
    },
    verification: {
      expectedFirstRun: null,
      sampleOutputs: [],
      validationStatus: "not_run",
    },
    social: {
      sourceUrl: null,
      revisionUrl: null,
    },
    provenance: {
      publishedByProfileId: null,
      revisionPublishedAt: "2026-05-16T00:00:00.000Z",
      previousRevisionId: null,
    },
    checksums: {
      artifact: HASH,
      redactionReport: HASH,
      manifest: HASH,
    },
  };
}

function publicClipFixture(input: { clipId: string; slug?: string }) {
  const slug = input.slug ?? "support-triage";
  return {
    id: input.clipId,
    slug,
    currentRevision: {
      revisionNumber: 1,
      manifestChecksum: HASH,
      artifactChecksum: HASH,
      manifestPayload: importableManifest(slug),
    },
  };
}

function createApp(actor: Record<string, unknown> = {
  type: "board",
  source: "local_implicit",
  userId: "board",
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", clipRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("clip routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes public publish moderation and trust states before persistence", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const clipId = "22222222-2222-4222-8222-222222222222";
    const revisionId = "33333333-3333-4333-8333-333333333333";
    mockClipService.publish.mockResolvedValue({
      clip: {
        id: clipId,
        slug: "support-triage",
        visibility: "public",
        status: "pending_review",
      },
      revision: {
        id: revisionId,
        revisionNumber: 1,
      },
      creatorProfile: {
        id: "44444444-4444-4444-8444-444444444444",
      },
    });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/clips/publish`)
      .send({
        creatorProfile: {
          handle: "support-team",
          displayName: "Support Team",
        },
        slug: "support-triage",
        type: "bundle",
        title: "Support Triage",
        summary: "Routes support tickets.",
        visibility: "public",
        status: "published",
        revision: {
          manifestChecksum: HASH,
          artifactChecksum: HASH,
          manifestPayload: { ok: true },
          securityReviewState: "security_reviewed",
          verificationState: "passed",
        },
      });

    expect(res.status).toBe(201);
    expect(mockClipService.publish).toHaveBeenCalledWith(companyId, expect.objectContaining({
      visibility: "public",
      status: "pending_review",
      revision: expect.objectContaining({
        securityReviewState: "unreviewed",
        verificationState: "not_run",
      }),
    }));
  });

  it("rejects malformed companyId path params before share-preview database lookups", async () => {
    const res = await request(createApp())
      .post("/api/companies/random-company-id/clips/share-preview")
      .send({ source: { type: "agent", id: "x" } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid companyId path parameter." });
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  });

  it("strips owner-supplied trust states when creating revisions", async () => {
    const clipId = "33333333-3333-4333-8333-333333333333";
    const sourceCompanyId = "22222222-2222-4222-8222-222222222222";
    mockClipService.getClipById.mockResolvedValue({
      id: clipId,
      slug: "support-triage",
      sourceCompanyId,
    });
    mockClipService.createRevision.mockResolvedValue({
      clip: { id: clipId, slug: "support-triage" },
      revision: { id: "44444444-4444-4444-8444-444444444444", revisionNumber: 2 },
    });

    const res = await request(createApp())
      .post("/api/clips/" + clipId + "/revisions")
      .send({
        manifestChecksum: "sha256:manifest-v2",
        artifactChecksum: "sha256:artifact-v2",
        manifestPayload: { schema: "paperclip.clip/v1" },
        securityReviewState: "security_reviewed",
        verificationState: "passed",
      });

    expect(res.status).toBe(201);
    expect(mockClipService.createRevision).toHaveBeenCalledWith(
      clipId,
      expect.objectContaining({
        securityReviewState: "unreviewed",
        verificationState: "not_run",
      }),
    );
  });

  it("rejects owner moderation, publish-status, and public-visibility patches", async () => {
    const clipId = "33333333-3333-4333-8333-333333333333";
    const sourceCompanyId = "22222222-2222-4222-8222-222222222222";
    mockClipService.getClipById.mockResolvedValue({
      id: clipId,
      slug: "support-triage",
      sourceCompanyId,
      status: "pending_review",
    });

    const moderationRes = await request(createApp())
      .patch("/api/clips/" + clipId)
      .send({ moderationState: "normal" });
    const publishRes = await request(createApp())
      .patch("/api/clips/" + clipId)
      .send({ status: "published" });
    const visibilityRes = await request(createApp())
      .patch("/api/clips/" + clipId)
      .send({ visibility: "public" });

    expect(moderationRes.status).toBe(403);
    expect(publishRes.status).toBe(403);
    expect(visibilityRes.status).toBe(403);
    expect(mockClipService.updateClip).not.toHaveBeenCalled();
  });

  it("rejects anonymous applied import telemetry", async () => {
    const res = await request(createApp({ type: "none", source: "none" }))
      .post("/api/public/clips/support-triage/import-telemetry")
      .send({ status: "applied" });

    expect(res.status).toBe(403);
    expect(mockClipService.recordImportTelemetry).not.toHaveBeenCalled();
  });

  it("uses the clip source company when building import previews", async () => {
    const destinationCompanyId = "11111111-1111-4111-8111-111111111111";
    const sourceCompanyId = "22222222-2222-4222-8222-222222222222";
    const clipId = "33333333-3333-4333-8333-333333333333";
    mockClipService.getPublicDetail.mockResolvedValue(publicClipFixture({ clipId }));
    mockClipService.getClipById.mockResolvedValue({ id: clipId, sourceCompanyId });
    mockCompanyPortabilityService.previewImport.mockResolvedValue({ warnings: [] });

    const res = await request(createApp())
      .post("/api/companies/" + destinationCompanyId + "/clips/import-preview")
      .send({ url: "https://paperclip.ing/clips/support-triage" });

    expect(res.status).toBe(200);
    expect(mockCompanyPortabilityService.previewImport).toHaveBeenCalledWith(
      expect.objectContaining({ target: { mode: "existing_company", companyId: destinationCompanyId } }),
      expect.objectContaining({ mode: "agent_safe", sourceCompanyId }),
    );
  });

  it("uses the clip source company when applying imports", async () => {
    const destinationCompanyId = "11111111-1111-4111-8111-111111111111";
    const sourceCompanyId = "22222222-2222-4222-8222-222222222222";
    const clipId = "33333333-3333-4333-8333-333333333333";
    mockClipService.getPublicDetail.mockResolvedValue(publicClipFixture({ clipId }));
    mockClipService.getClipById.mockResolvedValue({ id: clipId, sourceCompanyId });
    mockCompanyPortabilityService.previewImport.mockResolvedValue({ warnings: [] });
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      agents: [],
      projects: [],
      issues: [],
      skills: [],
      warnings: [],
    });

    const res = await request(createApp())
      .post("/api/companies/" + destinationCompanyId + "/clips/import")
      .send({ url: "https://paperclip.ing/clips/support-triage" });

    expect(res.status).toBe(200);
    expect(mockCompanyPortabilityService.importBundle).toHaveBeenCalledWith(
      expect.objectContaining({ target: { mode: "existing_company", companyId: destinationCompanyId } }),
      "board",
      expect.objectContaining({ mode: "agent_safe", sourceCompanyId }),
    );
  });
});
