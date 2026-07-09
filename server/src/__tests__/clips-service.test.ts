import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
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

  it("returns a clean conflict when publishing a duplicate slug", async () => {
    const companyId = await seedCompany();
    const { clip } = await publishFixture(companyId);

    await expect(svc.publish(companyId, {
      creatorProfile: {
        handle: "duplicate-creator-" + companyId.slice(0, 8),
        displayName: "Duplicate Creator",
      },
      slug: clip.slug,
      type: "agent",
      title: "Duplicate Slug Agent",
      summary: "Attempts to reuse an existing slug.",
      visibility: "public",
      status: "published",
      sourceKind: "paperclip_company_object",
      sourceObjectType: "agent",
      sourceObjectId: "duplicate-agent-id",
      revision: {
        manifestChecksum: "sha256:manifest-duplicate",
        artifactChecksum: "sha256:artifact-duplicate",
        manifestPayload: { schema: "paperclip.clip/v1", duplicate: true },
      },
    })).rejects.toThrow("Clip slug already exists");
  });

  it("rolls back initial publish when revision dependency insertion fails", async () => {
    const companyId = await seedCompany();
    const slug = "rollback-test-" + companyId.slice(0, 8);

    await expect(svc.publish(companyId, {
      creatorProfile: {
        handle: "rollback-creator-" + companyId.slice(0, 8),
        displayName: "Rollback Creator",
      },
      slug,
      type: "agent",
      title: "Rollback Test Agent",
      summary: "Exercises transaction rollback on publish.",
      visibility: "public",
      status: "published",
      sourceKind: "paperclip_company_object",
      sourceObjectType: "agent",
      sourceObjectId: "rollback-agent-id",
      revision: {
        manifestChecksum: "sha256:manifest-rollback",
        artifactChecksum: "sha256:artifact-rollback",
        manifestPayload: { schema: "paperclip.clip/v1", rollback: true },
        dependencies: [
          { type: "adapter", key: "codex_local" },
          { type: "adapter", key: "codex_local" },
        ],
      },
    })).rejects.toThrow();

    const rows = await db.select().from(clips).where(eq(clips.slug, slug));
    expect(rows).toHaveLength(0);
  });

  it("stores revisions append-only while keeping public reads on the last approved revision", async () => {
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
    const unapprovedRevision = await svc.getPublicRevision(clip.slug, update.revision.revisionNumber);

    expect(update.clip.currentRevisionId).toBe(update.revision.id);
    expect(update.clip.latestApprovedRevisionId).toBe(revision.id);
    expect(firstRevision?.currentRevision?.manifestChecksum).toBe("sha256:manifest-v1");
    expect(secondRevision?.currentRevision?.manifestChecksum).toBe("sha256:manifest-v1");
    expect(unapprovedRevision).toBeNull();
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

  it("serializes concurrent revision numbering for the same clip", async () => {
    const companyId = await seedCompany();
    const { clip } = await publishFixture(companyId);

    const [firstUpdate, secondUpdate] = await Promise.all([
      svc.createRevision(clip.id, {
        manifestChecksum: "sha256:manifest-concurrent-a",
        artifactChecksum: "sha256:artifact-concurrent-a",
        manifestPayload: { schema: "paperclip.clip/v1", revision: "a" },
        changeSummary: "Concurrent update A.",
      }),
      svc.createRevision(clip.id, {
        manifestChecksum: "sha256:manifest-concurrent-b",
        artifactChecksum: "sha256:artifact-concurrent-b",
        manifestPayload: { schema: "paperclip.clip/v1", revision: "b" },
        changeSummary: "Concurrent update B.",
      }),
    ]);

    expect([firstUpdate.revision.revisionNumber, secondUpdate.revision.revisionNumber].sort()).toEqual([2, 3]);
    const revisions = await db
      .select({ revisionNumber: clipRevisions.revisionNumber })
      .from(clipRevisions)
      .where(eq(clipRevisions.clipId, clip.id))
      .orderBy(asc(clipRevisions.revisionNumber));
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2, 3]);
  });

  it("queries creator profile clips by creator before applying limits without exposing unlisted clips", async () => {
    const targetCompanyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const [targetProfile] = await db.insert(clipCreatorProfiles).values({
      companyId: targetCompanyId,
      handle: "target-" + targetCompanyId.slice(0, 8),
      displayName: "Target Creator",
    }).returning();
    const [otherProfile] = await db.insert(clipCreatorProfiles).values({
      companyId: otherCompanyId,
      handle: "other-" + otherCompanyId.slice(0, 8),
      displayName: "Other Creator",
    }).returning();
    if (!targetProfile || !otherProfile) {
      throw new Error("Expected creator profiles to be inserted");
    }

    await db.insert(clips).values([
      {
        sourceCompanyId: targetCompanyId,
        creatorProfileId: targetProfile.id,
        slug: "target-public-" + targetCompanyId.slice(0, 8),
        type: "agent",
        title: "Target Public Clip",
        summary: "A public target clip.",
        visibility: "public",
        status: "published",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        sourceCompanyId: targetCompanyId,
        creatorProfileId: targetProfile.id,
        slug: "target-unlisted-" + targetCompanyId.slice(0, 8),
        type: "agent",
        title: "Target Unlisted Clip",
        summary: "An unlisted target clip.",
        visibility: "unlisted",
        status: "published",
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        sourceCompanyId: otherCompanyId,
        creatorProfileId: otherProfile.id,
        slug: "other-public-" + otherCompanyId.slice(0, 8) + "-" + index,
        type: "agent",
        title: "Other Public Clip " + index,
        summary: "A newer public clip from another creator.",
        visibility: "public",
        status: "published",
        updatedAt: new Date(Date.UTC(2026, 1, 1, 0, index)),
      })),
    ]);

    const profile = await svc.getCreatorPublicProfile(targetProfile.handle);

    expect(profile?.clips.map((clip) => clip.slug).sort()).toEqual([
      "target-public-" + targetCompanyId.slice(0, 8),
    ]);
  });

  it("does not trust showcase validation state for successful first-run metrics", async () => {
    const companyId = await seedCompany();
    const { clip } = await publishFixture(companyId);

    const updated = await svc.createShowcase(clip.slug, {
      title: "Community run report",
      validationState: "passed",
    }, {
      actorType: "user",
      actorId: "showcase-user",
      userId: "showcase-user",
    });

    expect(updated.showcaseCount).toBe(1);
    expect(updated.successfulFirstRunCount).toBe(0);
    const posts = await db.select().from(clipShowcasePosts).where(eq(clipShowcasePosts.clipId, clip.id));
    expect(posts[0]?.validationState).toBe("passed");
  });

  it("does not serve blocked or failed revisions through public revision reads", async () => {
    const companyId = await seedCompany();
    const { clip } = await publishFixture(companyId);

    const blocked = await svc.createRevision(clip.id, {
      manifestChecksum: "sha256:manifest-blocked",
      artifactChecksum: "sha256:artifact-blocked",
      manifestPayload: { schema: "paperclip.clip/v1", revision: "blocked" },
      securityReviewState: "blocked",
    });
    const failed = await svc.createRevision(clip.id, {
      manifestChecksum: "sha256:manifest-failed",
      artifactChecksum: "sha256:artifact-failed",
      manifestPayload: { schema: "paperclip.clip/v1", revision: "failed" },
      verificationState: "failed",
    });

    expect(await svc.getPublicRevision(clip.slug, blocked.revision.revisionNumber)).toBeNull();
    expect(await svc.getPublicRevision(clip.slug, failed.revision.revisionNumber)).toBeNull();
  });
});
