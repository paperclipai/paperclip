import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  clipComments,
  clipCreatorProfiles,
  clipDependencies,
  clipFlags,
  clipImports,
  clipModerationEvents,
  clipPublicMetricEvents,
  clipRankingSnapshots,
  clipRevisions,
  clipShowcasePosts,
  clipVotes,
  clips,
} from "@paperclipai/db";
import type {
  ClipDependency,
  ClipModerationState,
  ClipRevision,
  CreateClipComment,
  CreateClipCreatorProfile,
  CreateClipImportTelemetry,
  CreateClipReport,
  CreateClipRevision,
  CreateClipShowcase,
  CreateClipVote,
  PublicClip,
  PublishClip,
  UpdateClip,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

const PUBLIC_BROWSE_MODERATION_STATES = ["normal", "warning", "limited"];
const PUBLIC_DETAIL_MODERATION_STATES = ["normal", "under_review", "warning", "limited"];
const PUBLIC_DETAIL_VISIBILITIES = ["public", "unlisted"];
const PUBLIC_STATUS = "published";
const DEFAULT_MANIFEST_VERSION = "paperclip.clip/v1";

type Actor = {
  actorType: "agent" | "user" | "system" | "anonymous";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
};

function first<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

function publicMetrics(row: typeof clips.$inferSelect) {
  return {
    importCount: row.importCount,
    successfulFirstRunCount: row.successfulFirstRunCount,
    voteScore: row.voteScore,
    upvoteCount: row.upvoteCount,
    downvoteCount: row.downvoteCount,
    commentCount: row.commentCount,
    showcaseCount: row.showcaseCount,
    reportCount: row.reportCount,
  };
}

function serializePublicClip(input: {
  clip: typeof clips.$inferSelect;
  creator: typeof clipCreatorProfiles.$inferSelect;
  revision?: typeof clipRevisions.$inferSelect | null;
  dependencies?: (typeof clipDependencies.$inferSelect)[];
}): PublicClip {
  return {
    id: input.clip.id,
    slug: input.clip.slug,
    type: input.clip.type as PublicClip["type"],
    title: input.clip.title,
    summary: input.clip.summary,
    description: input.clip.description,
    visibility: input.clip.visibility as PublicClip["visibility"],
    status: input.clip.status as PublicClip["status"],
    moderationState: input.clip.moderationState as PublicClip["moderationState"],
    currentRevisionId: input.clip.currentRevisionId,
    latestApprovedRevisionId: input.clip.latestApprovedRevisionId,
    creatorProfileId: input.clip.creatorProfileId,
    creator: {
      id: input.creator.id,
      handle: input.creator.handle,
      displayName: input.creator.displayName,
      avatarUrl: input.creator.avatarUrl,
      verificationState: input.creator.verificationState,
      reputationSummary: input.creator.reputationSummary,
    },
    tags: input.clip.tags,
    categories: input.clip.categories,
    useCases: input.clip.useCases,
    requiredProviders: input.clip.requiredProviders,
    compatibility: input.clip.compatibility,
    metrics: publicMetrics(input.clip),
    currentRevision: input.revision
      ? {
        ...input.revision,
        securityReviewState: input.revision.securityReviewState as ClipRevision["securityReviewState"],
        verificationState: input.revision.verificationState as ClipRevision["verificationState"],
      }
      : null,
    dependencies: input.dependencies?.map((dependency) => ({
      ...dependency,
      type: dependency.type as ClipDependency["type"],
      required: dependency.required as ClipDependency["required"],
    })),
    createdAt: input.clip.createdAt,
    updatedAt: input.clip.updatedAt,
  };
}

function actorColumns(actor: Actor) {
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
  };
}

export function clipService(db: Db) {
  async function getCreatorProfileById(id: string) {
    return first(await db.select().from(clipCreatorProfiles).where(eq(clipCreatorProfiles.id, id)).limit(1));
  }

  async function getCreatorProfileByHandle(handle: string) {
    return first(await db.select().from(clipCreatorProfiles).where(eq(clipCreatorProfiles.handle, handle)).limit(1));
  }

  async function getClipById(id: string) {
    return first(await db.select().from(clips).where(eq(clips.id, id)).limit(1));
  }

  async function getClipBySlug(slug: string) {
    return first(await db.select().from(clips).where(eq(clips.slug, slug)).limit(1));
  }

  async function getRevisionByNumber(clipId: string, revisionNumber: number) {
    return first(
      await db
        .select()
        .from(clipRevisions)
        .where(and(eq(clipRevisions.clipId, clipId), eq(clipRevisions.revisionNumber, revisionNumber)))
        .limit(1),
    );
  }

  async function getPublicCurrentRevision(clip: typeof clips.$inferSelect) {
    const revisionId = clip.latestApprovedRevisionId ?? clip.currentRevisionId;
    if (!revisionId) return null;
    return first(await db.select().from(clipRevisions).where(eq(clipRevisions.id, revisionId)).limit(1));
  }

  async function getPublicClipBySlug(slug: string) {
    const rows = await db
      .select({ clip: clips, creator: clipCreatorProfiles })
      .from(clips)
      .innerJoin(clipCreatorProfiles, eq(clips.creatorProfileId, clipCreatorProfiles.id))
      .where(
        and(
          eq(clips.slug, slug),
          inArray(clips.visibility, PUBLIC_DETAIL_VISIBILITIES),
          eq(clips.status, PUBLIC_STATUS),
          inArray(clips.moderationState, PUBLIC_DETAIL_MODERATION_STATES),
        ),
      )
      .limit(1);
    return first(rows);
  }

  async function listPublic(input: {
    q?: string | null;
    type?: string | null;
    tag?: string | null;
    limit?: number;
    offset?: number;
  } = {}) {
    const conditions = [
      eq(clips.visibility, "public"),
      eq(clips.status, PUBLIC_STATUS),
      inArray(clips.moderationState, PUBLIC_BROWSE_MODERATION_STATES),
    ];
    if (input.type) conditions.push(eq(clips.type, input.type));
    if (input.q) {
      const q = `%${input.q.trim()}%`;
      conditions.push(sql`(${clips.title} ilike ${q} or ${clips.summary} ilike ${q})`);
    }
    if (input.tag) {
      conditions.push(sql`${clips.tags} @> ${JSON.stringify([input.tag])}::jsonb`);
    }

    const rows = await db
      .select({ clip: clips, creator: clipCreatorProfiles })
      .from(clips)
      .innerJoin(clipCreatorProfiles, eq(clips.creatorProfileId, clipCreatorProfiles.id))
      .where(and(...conditions))
      .orderBy(desc(clips.updatedAt))
      .limit(Math.min(Math.max(input.limit ?? 24, 1), 100))
      .offset(Math.max(input.offset ?? 0, 0));

    return rows.map((row) => serializePublicClip({ ...row }));
  }

  async function getPublicDetail(slug: string) {
    const row = await getPublicClipBySlug(slug);
    if (!row) return null;
    const revision = await getPublicCurrentRevision(row.clip);
    const dependencies = revision
      ? await db.select().from(clipDependencies).where(eq(clipDependencies.revisionId, revision.id))
      : [];
    return serializePublicClip({
      clip: row.clip,
      creator: row.creator,
      revision,
      dependencies,
    });
  }

  async function getPublicRevision(slug: string, revisionNumber: number) {
    const row = await getPublicClipBySlug(slug);
    if (!row) return null;
    const revision = await getRevisionByNumber(row.clip.id, revisionNumber);
    if (!revision) return null;
    const dependencies = await db.select().from(clipDependencies).where(eq(clipDependencies.revisionId, revision.id));
    return serializePublicClip({
      clip: row.clip,
      creator: row.creator,
      revision,
      dependencies,
    });
  }

  async function createCreatorProfile(companyId: string, input: CreateClipCreatorProfile) {
    const [profile] = await db
      .insert(clipCreatorProfiles)
      .values({
        companyId,
        handle: input.handle,
        displayName: input.displayName,
        bio: input.bio ?? null,
        avatarUrl: input.avatarUrl ?? null,
        websiteUrl: input.websiteUrl ?? null,
        verificationState: input.verificationState ?? "unverified",
        reputationSummary: input.reputationSummary ?? {},
      })
      .returning();
    return profile;
  }

  async function resolveCreatorProfile(companyId: string, input: PublishClip) {
    if (input.creatorProfileId) {
      const profile = await getCreatorProfileById(input.creatorProfileId);
      if (!profile || profile.companyId !== companyId) {
        throw unprocessable("Creator profile does not belong to this company");
      }
      return profile;
    }
    if (!input.creatorProfile) throw unprocessable("creatorProfileId or creatorProfile is required");
    const existing = await getCreatorProfileByHandle(input.creatorProfile.handle);
    if (existing) {
      if (existing.companyId !== companyId) {
        throw conflict("Creator profile handle already belongs to another company");
      }
      return existing;
    }
    return createCreatorProfile(companyId, input.creatorProfile);
  }

  async function insertRevision(clipId: string, input: CreateClipRevision, requestedRevisionNumber?: number) {
    const revisionNumber = requestedRevisionNumber ?? await nextRevisionNumber(clipId);
    const [revision] = await db
      .insert(clipRevisions)
      .values({
        clipId,
        revisionNumber,
        manifestVersion: input.manifestVersion ?? DEFAULT_MANIFEST_VERSION,
        manifestChecksum: input.manifestChecksum,
        artifactChecksum: input.artifactChecksum,
        manifestPayload: input.manifestPayload,
        artifactRef: input.artifactRef ?? null,
        dependencyGraph: input.dependencyGraph ?? {},
        permissions: input.permissions ?? [],
        secretsSchema: input.secretsSchema ?? [],
        budgetEstimate: input.budgetEstimate ?? null,
        redactionReport: input.redactionReport ?? {},
        dangerousCapabilities: input.dangerousCapabilities ?? [],
        securityReviewState: input.securityReviewState ?? "unreviewed",
        verificationState: input.verificationState ?? "not_run",
        compatibility: input.compatibility ?? {},
        changeSummary: input.changeSummary ?? null,
        breakingChanges: input.breakingChanges ?? null,
        migrationNotes: input.migrationNotes ?? null,
      })
      .returning();

    if (input.dependencies?.length) {
      await db.insert(clipDependencies).values(
        input.dependencies.map((dependency) => ({
          clipId,
          revisionId: revision.id,
          type: dependency.type,
          key: dependency.key,
          displayName: dependency.displayName ?? null,
          required: dependency.required ?? "required",
          metadata: dependency.metadata ?? {},
        })),
      );
    }
    return revision;
  }

  async function nextRevisionNumber(clipId: string) {
    const [row] = await db
      .select({ maxRevision: sql<number>`coalesce(max(${clipRevisions.revisionNumber}), 0)` })
      .from(clipRevisions)
      .where(eq(clipRevisions.clipId, clipId));
    return Number(row?.maxRevision ?? 0) + 1;
  }

  async function publish(companyId: string, input: PublishClip) {
    const existing = await getClipBySlug(input.slug);
    if (existing) throw conflict("Clip slug already exists");
    const creatorProfile = await resolveCreatorProfile(companyId, input);
    const [clip] = await db
      .insert(clips)
      .values({
        sourceCompanyId: companyId,
        creatorProfileId: creatorProfile.id,
        slug: input.slug,
        type: input.type,
        title: input.title,
        summary: input.summary,
        description: input.description ?? null,
        visibility: input.visibility ?? "unlisted",
        status: input.status ?? (input.visibility === "public" ? "pending_review" : "published"),
        tags: input.tags ?? [],
        categories: input.categories ?? [],
        useCases: input.useCases ?? [],
        requiredProviders: input.requiredProviders ?? [],
        compatibility: input.compatibility ?? {},
        sourceKind: input.sourceKind ?? null,
        sourceObjectType: input.sourceObjectType ?? null,
        sourceObjectId: input.sourceObjectId ?? null,
      })
      .returning();
    const revision = await insertRevision(clip.id, input.revision, 1);
    const visibleRevisionId = clip.status === "published" ? revision.id : null;
    const [updated] = await db
      .update(clips)
      .set({
        currentRevisionId: revision.id,
        latestApprovedRevisionId: visibleRevisionId,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, clip.id))
      .returning();
    await rebuildRankingSnapshot(updated);
    return { clip: updated, revision, creatorProfile };
  }

  async function createRevision(clipId: string, input: CreateClipRevision) {
    const clip = await getClipById(clipId);
    if (!clip) throw notFound("Clip not found");
    const revision = await insertRevision(clip.id, input);
    const [updated] = await db
      .update(clips)
      .set({
        currentRevisionId: revision.id,
        latestApprovedRevisionId: clip.status === "published" && clip.moderationState !== "blocked" ? revision.id : clip.latestApprovedRevisionId,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, clip.id))
      .returning();
    await rebuildRankingSnapshot(updated);
    return { clip: updated, revision };
  }

  async function updateClip(clipId: string, input: UpdateClip, actor: Actor) {
    const existing = await getClipById(clipId);
    if (!existing) throw notFound("Clip not found");

    if (input.latestApprovedRevisionId) {
      const revision = first(
        await db
          .select()
          .from(clipRevisions)
          .where(and(eq(clipRevisions.id, input.latestApprovedRevisionId), eq(clipRevisions.clipId, clipId)))
          .limit(1),
      );
      if (!revision) throw unprocessable("latestApprovedRevisionId must belong to this clip");
    }

    const moderationStateChanged =
      input.moderationState !== undefined && input.moderationState !== existing.moderationState;

    const [updated] = await db
      .update(clips)
      .set({
        title: input.title ?? existing.title,
        summary: input.summary ?? existing.summary,
        description: input.description === undefined ? existing.description : input.description,
        visibility: input.visibility ?? existing.visibility,
        status: input.status ?? existing.status,
        moderationState: input.moderationState ?? existing.moderationState,
        latestApprovedRevisionId: input.latestApprovedRevisionId === undefined
          ? existing.latestApprovedRevisionId
          : input.latestApprovedRevisionId,
        tags: input.tags ?? existing.tags,
        categories: input.categories ?? existing.categories,
        useCases: input.useCases ?? existing.useCases,
        requiredProviders: input.requiredProviders ?? existing.requiredProviders,
        compatibility: input.compatibility ?? existing.compatibility,
        delistedAt: input.status === "delisted" || input.moderationState === "delisted" ? new Date() : existing.delistedAt,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, clipId))
      .returning();

    if (moderationStateChanged) {
      await db.insert(clipModerationEvents).values({
        clipId,
        ...actorColumns(actor),
        fromState: existing.moderationState,
        toState: input.moderationState as ClipModerationState,
        reason: input.moderationReason ?? "moderation_state_updated",
      });
    }
    await rebuildRankingSnapshot(updated);
    return updated;
  }

  async function createVote(slug: string, input: CreateClipVote, actor: Actor) {
    const row = await getPublicClipBySlug(slug);
    if (!row) throw notFound("Clip not found");
    const revision = input.revisionNumber
      ? await getRevisionByNumber(row.clip.id, input.revisionNumber)
      : await getPublicCurrentRevision(row.clip);
    if (!revision) throw notFound("Clip revision not found");

    const existing = first(
      await db
        .select()
        .from(clipVotes)
        .where(and(
          eq(clipVotes.revisionId, revision.id),
          eq(clipVotes.actorType, actor.actorType),
          eq(clipVotes.actorId, actor.actorId),
        ))
        .limit(1),
    );

    if (existing) {
      await db
        .update(clipVotes)
        .set({ vote: input.vote, reason: input.reason ?? null, metadata: input.metadata ?? {}, updatedAt: new Date() })
        .where(eq(clipVotes.id, existing.id));
    } else {
      await db.insert(clipVotes).values({
        clipId: row.clip.id,
        revisionId: revision.id,
        actorType: actor.actorType,
        actorId: actor.actorId,
        vote: input.vote,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
      });
    }
    const updated = await refreshVoteCounters(row.clip.id);
    await rebuildRankingSnapshot(updated);
    return { clip: updated, revision };
  }

  async function createReport(slug: string, input: CreateClipReport, actor: Actor) {
    const row = await getPublicClipBySlug(slug);
    if (!row) throw notFound("Clip not found");
    const revision = input.revisionNumber ? await getRevisionByNumber(row.clip.id, input.revisionNumber) : null;
    await db.insert(clipFlags).values({
      clipId: row.clip.id,
      revisionId: revision?.id ?? null,
      reporterType: actor.actorType,
      reporterId: actor.actorType === "anonymous" ? null : actor.actorId,
      reason: input.reason,
      details: input.details ?? null,
      metadata: input.metadata ?? {},
    });
    const [updated] = await db
      .update(clips)
      .set({
        reportCount: sql`${clips.reportCount} + 1`,
        moderationState: row.clip.moderationState === "normal" ? "under_review" : row.clip.moderationState,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, row.clip.id))
      .returning();
    await rebuildRankingSnapshot(updated);
    return updated;
  }

  async function createComment(slug: string, input: CreateClipComment, actor: Actor) {
    const row = await getPublicClipBySlug(slug);
    if (!row) throw notFound("Clip not found");
    const revision = input.revisionNumber ? await getRevisionByNumber(row.clip.id, input.revisionNumber) : null;
    await db.insert(clipComments).values({
      clipId: row.clip.id,
      revisionId: revision?.id ?? null,
      authorUserId: actor.userId ?? null,
      authorAgentId: actor.agentId ?? null,
      scope: input.scope ?? (revision ? "revision" : "clip"),
      category: input.category ?? "question",
      body: input.body,
    });
    const [updated] = await db
      .update(clips)
      .set({ commentCount: sql`${clips.commentCount} + 1`, updatedAt: new Date() })
      .where(eq(clips.id, row.clip.id))
      .returning();
    return updated;
  }

  async function createShowcase(slug: string, input: CreateClipShowcase, actor: Actor) {
    const row = await getPublicClipBySlug(slug);
    if (!row) throw notFound("Clip not found");
    const revision = input.revisionNumber
      ? await getRevisionByNumber(row.clip.id, input.revisionNumber)
      : await getPublicCurrentRevision(row.clip);
    if (!revision) throw notFound("Clip revision not found");
    await db.insert(clipShowcasePosts).values({
      clipId: row.clip.id,
      revisionId: revision.id,
      authorUserId: actor.userId ?? null,
      authorAgentId: actor.agentId ?? null,
      type: input.type ?? "community_example",
      title: input.title,
      body: input.body ?? null,
      mediaRefs: input.mediaRefs ?? [],
      validationState: input.validationState ?? "not_run",
    });
    const [updated] = await db
      .update(clips)
      .set({
        showcaseCount: sql`${clips.showcaseCount} + 1`,
        successfulFirstRunCount: input.validationState === "passed"
          ? sql`${clips.successfulFirstRunCount} + 1`
          : row.clip.successfulFirstRunCount,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, row.clip.id))
      .returning();
    await rebuildRankingSnapshot(updated);
    return updated;
  }

  async function recordImportTelemetry(slug: string, input: CreateClipImportTelemetry, actor: Actor) {
    const row = await getPublicClipBySlug(slug);
    if (!row) throw notFound("Clip not found");
    const revision = input.revisionNumber
      ? await getRevisionByNumber(row.clip.id, input.revisionNumber)
      : await getPublicCurrentRevision(row.clip);
    if (!revision) throw notFound("Clip revision not found");
    await db.insert(clipPublicMetricEvents).values({
      clipId: row.clip.id,
      revisionId: revision.id,
      eventType: "import_telemetry",
      actorHash: actor.actorType === "anonymous" ? null : `${actor.actorType}:${actor.actorId}`,
      metadata: input.metadata ?? {},
    });
    if (input.destinationCompanyId) {
      await db.insert(clipImports).values({
        destinationCompanyId: input.destinationCompanyId,
        clipId: row.clip.id,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        manifestChecksum: revision.manifestChecksum,
        artifactChecksum: revision.artifactChecksum,
        sourceUrl: input.sourceUrl ?? null,
        revisionUrl: input.revisionUrl ?? null,
        status: input.status ?? "previewed",
        importedByUserId: actor.userId ?? null,
        importedByAgentId: actor.agentId ?? null,
      });
    }
    const [updated] = await db
      .update(clips)
      .set({
        importCount: input.status === "applied" ? sql`${clips.importCount} + 1` : row.clip.importCount,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, row.clip.id))
      .returning();
    await rebuildRankingSnapshot(updated);
    return updated;
  }

  async function refreshVoteCounters(clipId: string) {
    const [updated] = await db
      .update(clips)
      .set({
        upvoteCount: sql`(select count(*)::int from ${clipVotes} where ${clipVotes.clipId} = ${clipId} and ${clipVotes.vote} = 'up')`,
        downvoteCount: sql`(select count(*)::int from ${clipVotes} where ${clipVotes.clipId} = ${clipId} and ${clipVotes.vote} = 'down')`,
        voteScore: sql`(
          (select count(*)::int from ${clipVotes} where ${clipVotes.clipId} = ${clipId} and ${clipVotes.vote} = 'up')
          -
          (select count(*)::int from ${clipVotes} where ${clipVotes.clipId} = ${clipId} and ${clipVotes.vote} = 'down')
        )`,
        updatedAt: new Date(),
      })
      .where(eq(clips.id, clipId))
      .returning();
    return updated;
  }

  async function rebuildRankingSnapshot(clip: typeof clips.$inferSelect) {
    const reviewBonus = clip.moderationState === "normal" ? 10 : clip.moderationState === "warning" ? -10 : -30;
    const score =
      reviewBonus
      + clip.successfulFirstRunCount * 10
      + clip.importCount * 3
      + clip.upvoteCount * 2
      - clip.downvoteCount * 2
      - clip.reportCount * 8
      + clip.showcaseCount * 3;
    await db
      .insert(clipRankingSnapshots)
      .values({
        clipId: clip.id,
        scope: "global",
        score,
        factors: {
          moderationState: clip.moderationState,
          successfulFirstRunCount: clip.successfulFirstRunCount,
          importCount: clip.importCount,
          upvoteCount: clip.upvoteCount,
          downvoteCount: clip.downvoteCount,
          reportCount: clip.reportCount,
          showcaseCount: clip.showcaseCount,
        },
      })
      .onConflictDoUpdate({
        target: [clipRankingSnapshots.clipId, clipRankingSnapshots.scope],
        set: {
          score,
          factors: {
            moderationState: clip.moderationState,
            successfulFirstRunCount: clip.successfulFirstRunCount,
            importCount: clip.importCount,
            upvoteCount: clip.upvoteCount,
            downvoteCount: clip.downvoteCount,
            reportCount: clip.reportCount,
            showcaseCount: clip.showcaseCount,
          },
          snapshotAt: new Date(),
        },
      });
  }

  async function getCreatorPublicProfile(handle: string) {
    const profile = first(
      await db
        .select()
        .from(clipCreatorProfiles)
        .where(ilike(clipCreatorProfiles.handle, handle))
        .limit(1),
    );
    if (!profile) return null;
    const publicClips = await listPublic({ limit: 100 });
    return {
      profile: {
        id: profile.id,
        handle: profile.handle,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        websiteUrl: profile.websiteUrl,
        verificationState: profile.verificationState,
        reputationSummary: profile.reputationSummary,
      },
      clips: publicClips.filter((clip) => clip.creatorProfileId === profile.id),
    };
  }

  return {
    createCreatorProfile,
    getCreatorProfileById,
    getCreatorProfileByHandle,
    getClipById,
    getClipBySlug,
    listPublic,
    getPublicDetail,
    getPublicRevision,
    getCreatorPublicProfile,
    publish,
    createRevision,
    updateClip,
    createVote,
    createReport,
    createComment,
    createShowcase,
    recordImportTelemetry,
  };
}
