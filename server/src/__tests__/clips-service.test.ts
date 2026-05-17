import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clipComments,
  clipCreatorProfiles,
  clipDependencies,
  clipFlags,
  clipImportedObjects,
  clipImports,
  clipModerationEvents,
  clipPublicMetricEvents,
  clipRankingSnapshots,
  clipRevisions,
  clipShowcasePosts,
  clipVotes,
  clips,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { clipService } from "../services/clips.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres clips service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("clipService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof clipService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-clips-service-");
    db = createDb(tempDb.connectionString);
    svc = clipService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(clipPublicMetricEvents);
    await db.delete(clipImportedObjects);
    await db.delete(clipImports);
    await db.delete(clipRankingSnapshots);
    await db.delete(clipModerationEvents);
    await db.delete(clipShowcasePosts);
    await db.delete(clipVotes);
    await db.delete(clipComments);
    await db.delete(clipFlags);
    await db.delete(clipDependencies);
    await db.delete(clipRevisions);
    await db.delete(clips);
    await db.delete(clipCreatorProfiles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function publishFixture(companyId: string) {
    return svc.publish(companyId, {
      creatorProfile: {
        handle: `creator-${companyId.slice(0, 8)}`,
        displayName: "Creator Labs",
      },
      slug: `support-triage-${companyId.slice(0, 8)}`,
      type: "agent",
      title: "Support Triage Agent",
      summary: "Routes support tickets to the right specialist.",
      description: "A sanitized public description.",
      visibility: "public",
      status: "published",
      tags: ["support"],
      requiredProviders: ["github"],
      sourceKind: "paperclip_company_object",
      sourceObjectType: "agent",
      sourceObjectId: "private-agent-id",
      revision: {
        manifestVersion: "paperclip.clip/v1",
        manifestChecksum: "sha256:manifest-v1",
        artifactChecksum: "sha256:artifact-v1",
        manifestPayload: {
          schema: "paperclip.clip/v1",
          privateSourceCompanyId: "must-not-come-from-public-api",
          clip: { slug: "support-triage" },
        },
        dependencyGraph: { adapters: [{ type: "codex_local" }] },
        dependencies: [
          { type: "adapter", key: "codex_local", required: "optional" },
          { type: "permission", key: "github.issues.write" },
        ],
        redactionReport: { summary: { omitted: 3 } },
        dangerousCapabilities: ["github"],
      },
    });
  }

  it("publishes sanitized public detail without exposing private source identifiers", async () => {
    const companyId = await seedCompany();
    const { clip, revision } = await publishFixture(companyId);

    const detail = await svc.getPublicDetail(clip.slug);

    expect(detail).toMatchObject({
      id: clip.id,
      slug: clip.slug,
      title: "Support Triage Agent",
      currentRevision: {
        id: revision.id,
        revisionNumber: 1,
        manifestChecksum: "sha256:manifest-v1",
      },
    });
    expect(detail?.dependencies?.map((dependency) => dependency.key).sort()).toEqual([
      "codex_local",
      "github.issues.write",
    ]);
    expect(detail).not.toHaveProperty("sourceCompanyId");
    expect(detail).not.toHaveProperty("sourceObjectId");
  });

  it("stores revisions append-only and serves exact revision manifests", async () => {
    const companyId = await seedCompany();
    const { clip, revision } = await publishFixture(companyId);

    const update = await svc.createRevision(clip.id, {
      manifestChecksum: "sha256:manifest-v2",
      artifactChecksum: "sha256:artifact-v2",
      manifestPayload: { schema: "paperclip.clip/v1", revision: 2 },
      changeSummary: "Adds a safer default.",
    });

    expect(update.revision.revisionNumber).toBe(2);
    const firstRevision = await svc.getPublicRevision(clip.slug, 1);
    const secondRevision = await svc.getPublicDetail(clip.slug);

    expect(firstRevision?.currentRevision?.manifestChecksum).toBe("sha256:manifest-v1");
    expect(secondRevision?.currentRevision?.manifestChecksum).toBe("sha256:manifest-v2");
    await expect(
      db.update(clipRevisions).set({ changeSummary: "mutated" }).where(eq(clipRevisions.id, revision.id)),
    ).rejects.toThrow(/Failed query/);
    const [unchanged] = await db.select().from(clipRevisions).where(eq(clipRevisions.id, revision.id));
    expect(unchanged?.changeSummary).toBeNull();
  });

  it("enforces public moderation state on reads while keeping report audit data", async () => {
    const companyId = await seedCompany();
    const { clip } = await publishFixture(companyId);

    await svc.createReport(clip.slug, { reason: "unsafe_automation", details: "It asks for broad shell access." }, {
      actorType: "anonymous",
      actorId: "anonymous",
    });
    const underReview = await svc.getPublicDetail(clip.slug);
    expect(underReview?.moderationState).toBe("under_review");

    await svc.updateClip(clip.id, { moderationState: "blocked", moderationReason: "Confirmed malicious behavior." }, {
      actorType: "user",
      actorId: "moderator",
    });

    expect(await svc.getPublicDetail(clip.slug)).toBeNull();
    const reports = await db.select().from(clipFlags).where(eq(clipFlags.clipId, clip.id));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.reason).toBe("unsafe_automation");
  });
});
