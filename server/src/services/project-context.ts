import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySkills,
  contextSourceChunks,
  contextSourceItems,
  contextSources,
  contextSourceSyncRuns,
  issueComments,
  issues,
  projectContextProfiles,
  projects,
} from "@paperclipai/db";
import type {
  ContextSource,
  ContextSourceCreateRequest,
  ContextSourceItem,
  ContextSourceSearchResult,
  ContextSourceStatus,
  ContextSourceUpsertItemRequest,
  ProjectContextBundle,
  ProjectContextProfile,
  ProjectContextProfileUpdateRequest,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const DEFAULT_MAX_BUNDLE_CHARS = 12_000;
const DEFAULT_MAX_CHUNKS = 8;
const CHUNK_TARGET_CHARS = 1_800;
const CHUNK_OVERLAP_CHARS = 160;
const MAX_QUERY_CHARS = 3_000;
const MAX_EXCERPT_CHARS = 1_000;
const FTS_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "from",
  "into",
  "that",
  "this",
  "with",
  "without",
  "your",
]);

type ProjectContextProfileRow = typeof projectContextProfiles.$inferSelect;
type ContextSourceRow = typeof contextSources.$inferSelect;
type ContextSourceItemRow = typeof contextSourceItems.$inferSelect;

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\r\n/g, "\n").replace(/\t/g, " ").trim();
}

function tokenEstimate(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function sanitizeLimit(value: number | null | undefined, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function buildSearchQueryText(query: string) {
  const terms = Array.from(new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []))
    .filter((term) => term.length > 2 && !FTS_STOP_WORDS.has(term))
    .slice(0, 24);
  if (terms.length === 0) return null;
  return terms.map((term) => `${term}:*`).join(" | ");
}

function chunkText(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const block of blocks.length > 0 ? blocks : [normalized]) {
    if (block.length > CHUNK_TARGET_CHARS) {
      pushCurrent();
      for (let start = 0; start < block.length; start += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS) {
        chunks.push(block.slice(start, start + CHUNK_TARGET_CHARS).trim());
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > CHUNK_TARGET_CHARS) {
      pushCurrent();
      current = block;
    } else {
      current = candidate;
    }
  }
  pushCurrent();
  return chunks.filter(Boolean);
}

function toProfile(row: ProjectContextProfileRow): ProjectContextProfile {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    goalMarkdown: row.goalMarkdown,
    instructionsMarkdown: row.instructionsMarkdown,
    defaultSkillKeys: Array.isArray(row.defaultSkillKeys) ? row.defaultSkillKeys : [],
    retrievalEnabled: row.retrievalEnabled,
    maxBundleChars: row.maxBundleChars,
    maxChunks: row.maxChunks,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaultProfile(companyId: string, projectId: string): ProjectContextProfile {
  const now = new Date(0);
  return {
    id: "",
    companyId,
    projectId,
    goalMarkdown: "",
    instructionsMarkdown: "",
    defaultSkillKeys: [],
    retrievalEnabled: true,
    maxBundleChars: DEFAULT_MAX_BUNDLE_CHARS,
    maxChunks: DEFAULT_MAX_CHUNKS,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

function toSource(row: ContextSourceRow, countsBySourceId = new Map<string, { itemCount: number; chunkCount: number }>()): ContextSource {
  const counts = countsBySourceId.get(row.id);
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    sourceType: row.sourceType as ContextSource["sourceType"],
    provider: row.provider ?? null,
    title: row.title,
    uri: row.uri ?? null,
    status: row.status as ContextSourceStatus,
    statusMessage: row.statusMessage ?? null,
    assetId: row.assetId ?? null,
    externalId: row.externalId ?? null,
    metadata: row.metadata ?? null,
    lastSyncedAt: row.lastSyncedAt ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    itemCount: counts?.itemCount ?? 0,
    chunkCount: counts?.chunkCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toItem(row: ContextSourceItemRow): ContextSourceItem {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    sourceId: row.sourceId,
    externalId: row.externalId ?? null,
    title: row.title,
    uri: row.uri ?? null,
    mimeType: row.mimeType ?? null,
    bodyText: row.bodyText ?? null,
    bodySha256: row.bodySha256 ?? null,
    status: row.status as ContextSourceItem["status"],
    statusMessage: row.statusMessage ?? null,
    metadata: row.metadata ?? null,
    sourceModifiedAt: row.sourceModifiedAt ?? null,
    indexedAt: row.indexedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function countSourceChildren(db: Db, sourceIds: string[]) {
  const out = new Map<string, { itemCount: number; chunkCount: number }>();
  if (sourceIds.length === 0) return out;
  const itemRows = await db
    .select({ sourceId: contextSourceItems.sourceId, value: count() })
    .from(contextSourceItems)
    .where(inArray(contextSourceItems.sourceId, sourceIds))
    .groupBy(contextSourceItems.sourceId);
  const chunkRows = await db
    .select({ sourceId: contextSourceChunks.sourceId, value: count() })
    .from(contextSourceChunks)
    .where(inArray(contextSourceChunks.sourceId, sourceIds))
    .groupBy(contextSourceChunks.sourceId);
  for (const row of itemRows) {
    out.set(row.sourceId, { itemCount: Number(row.value), chunkCount: 0 });
  }
  for (const row of chunkRows) {
    const current = out.get(row.sourceId) ?? { itemCount: 0, chunkCount: 0 };
    current.chunkCount = Number(row.value);
    out.set(row.sourceId, current);
  }
  return out;
}

export function projectContextService(db: Db) {
  async function getProject(companyId: string, projectId: string) {
    return db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
      .then((rows) => rows[0] ?? null);
  }

  async function requireProject(companyId: string, projectId: string) {
    const project = await getProject(companyId, projectId);
    if (!project) throw unprocessable("Project does not belong to this company.");
    return project;
  }

  async function getProfileRow(companyId: string, projectId: string) {
    return db
      .select()
      .from(projectContextProfiles)
      .where(and(eq(projectContextProfiles.companyId, companyId), eq(projectContextProfiles.projectId, projectId)))
      .then((rows) => rows[0] ?? null);
  }

  async function ensureProfile(companyId: string, projectId: string) {
    await requireProject(companyId, projectId);
    const existing = await getProfileRow(companyId, projectId);
    if (existing) return toProfile(existing);
    const row = await db
      .insert(projectContextProfiles)
      .values({ companyId, projectId })
      .onConflictDoNothing({ target: projectContextProfiles.projectId })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (row) return toProfile(row);
    const createdByOther = await getProfileRow(companyId, projectId);
    return createdByOther ? toProfile(createdByOther) : defaultProfile(companyId, projectId);
  }

  async function validateSkillKeys(companyId: string, skillKeys: string[]) {
    const deduped = Array.from(new Set(skillKeys.map((value) => value.trim()).filter(Boolean)));
    if (deduped.length === 0) return deduped;
    const rows = await db
      .select({ key: companySkills.key })
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.key, deduped)));
    const existing = new Set(rows.map((row) => row.key));
    const missing = deduped.filter((key) => !existing.has(key));
    if (missing.length > 0) {
      throw unprocessable("One or more project context skills are not available in this company.", { missing });
    }
    return deduped;
  }

  async function replaceChunksForItem(item: ContextSourceItemRow) {
    await db.delete(contextSourceChunks).where(eq(contextSourceChunks.itemId, item.id));
    const chunks = chunkText(item.bodyText ?? "");
    if (chunks.length === 0) return 0;
    await db.insert(contextSourceChunks).values(
      chunks.map((content, index) => ({
        companyId: item.companyId,
        projectId: item.projectId,
        sourceId: item.sourceId,
        itemId: item.id,
        chunkIndex: index,
        content,
        tokenEstimate: tokenEstimate(content),
      })),
    );
    return chunks.length;
  }

  async function upsertItem(source: ContextSourceRow, input: ContextSourceUpsertItemRequest) {
    const bodyText = normalizeText(input.bodyText);
    const bodySha256 = bodyText ? hashText(bodyText) : null;
    const status = input.status ?? (bodyText ? "ready" : "unsupported");
    const sourceModifiedAt = input.sourceModifiedAt ? new Date(input.sourceModifiedAt) : null;
    const now = new Date();
    const existing =
      input.externalId
        ? await db
            .select()
            .from(contextSourceItems)
            .where(and(eq(contextSourceItems.sourceId, source.id), eq(contextSourceItems.externalId, input.externalId)))
            .then((rows) => rows[0] ?? null)
        : null;

    const values = {
      companyId: source.companyId,
      projectId: source.projectId,
      sourceId: source.id,
      externalId: input.externalId ?? null,
      title: input.title,
      uri: input.uri ?? null,
      mimeType: input.mimeType ?? null,
      bodyText: bodyText || null,
      bodySha256,
      status,
      statusMessage: input.statusMessage ?? null,
      metadata: input.metadata ?? null,
      sourceModifiedAt,
      indexedAt: now,
      updatedAt: now,
    };

    const item = existing
      ? await db
          .update(contextSourceItems)
          .set(values)
          .where(eq(contextSourceItems.id, existing.id))
          .returning()
          .then((rows) => rows[0]!)
      : await db
          .insert(contextSourceItems)
          .values(values)
          .returning()
          .then((rows) => rows[0]!);

    const chunkCount = status === "ready" ? await replaceChunksForItem(item) : 0;
    await db
      .update(contextSources)
      .set({
        status: status === "error" ? "error" : "ready",
        statusMessage: status === "error" ? input.statusMessage ?? "Item indexing failed." : null,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(contextSources.id, source.id));
    return { item: toItem(item), chunkCount };
  }

  async function sourceById(companyId: string, sourceId: string) {
    return db
      .select()
      .from(contextSources)
      .where(and(eq(contextSources.companyId, companyId), eq(contextSources.id, sourceId)))
      .then((rows) => rows[0] ?? null);
  }

  return {
    getProfileOrDefault: async (companyId: string, projectId: string): Promise<ProjectContextProfile> => {
      const row = await getProfileRow(companyId, projectId);
      return row ? toProfile(row) : defaultProfile(companyId, projectId);
    },

    ensureProfile,

    updateProfile: async (
      companyId: string,
      projectId: string,
      input: ProjectContextProfileUpdateRequest,
    ): Promise<ProjectContextProfile> => {
      const existing = await ensureProfile(companyId, projectId);
      const patch: Partial<typeof projectContextProfiles.$inferInsert> = { updatedAt: new Date() };
      if (input.goalMarkdown !== undefined) patch.goalMarkdown = input.goalMarkdown;
      if (input.instructionsMarkdown !== undefined) patch.instructionsMarkdown = input.instructionsMarkdown;
      if (input.defaultSkillKeys !== undefined) {
        patch.defaultSkillKeys = await validateSkillKeys(companyId, input.defaultSkillKeys);
      }
      if (input.retrievalEnabled !== undefined) patch.retrievalEnabled = input.retrievalEnabled;
      if (input.maxBundleChars !== undefined) patch.maxBundleChars = sanitizeLimit(input.maxBundleChars, existing.maxBundleChars, 100_000);
      if (input.maxChunks !== undefined) patch.maxChunks = sanitizeLimit(input.maxChunks, existing.maxChunks, 50);

      const row = await db
        .update(projectContextProfiles)
        .set(patch)
        .where(eq(projectContextProfiles.id, existing.id))
        .returning()
        .then((rows) => rows[0]!);
      return toProfile(row);
    },

    listSources: async (companyId: string, projectId: string): Promise<ContextSource[]> => {
      await requireProject(companyId, projectId);
      const rows = await db
        .select()
        .from(contextSources)
        .where(and(eq(contextSources.companyId, companyId), eq(contextSources.projectId, projectId)))
        .orderBy(desc(contextSources.updatedAt), asc(contextSources.title));
      const countsBySourceId = await countSourceChildren(db, rows.map((row) => row.id));
      return rows.map((row) => toSource(row, countsBySourceId));
    },

    overview: async (companyId: string, projectId: string) => ({
      profile: await ensureProfile(companyId, projectId),
      sources: await (async () => {
        const rows = await db
          .select()
          .from(contextSources)
          .where(and(eq(contextSources.companyId, companyId), eq(contextSources.projectId, projectId)))
          .orderBy(desc(contextSources.updatedAt), asc(contextSources.title));
        const countsBySourceId = await countSourceChildren(db, rows.map((row) => row.id));
        return rows.map((row) => toSource(row, countsBySourceId));
      })(),
    }),

    createSource: async (
      companyId: string,
      projectId: string,
      input: ContextSourceCreateRequest & {
        assetId?: string | null;
        createdByAgentId?: string | null;
        createdByUserId?: string | null;
      },
    ): Promise<ContextSource> => {
      await requireProject(companyId, projectId);
      const bodyText = normalizeText(input.bodyText);
      const sourceStatus = bodyText || input.sourceType === "google_drive" ? "ready" : "disabled";
      const source = await db
        .insert(contextSources)
        .values({
          companyId,
          projectId,
          sourceType: input.sourceType,
          provider: input.provider ?? (input.sourceType === "google_drive" ? "google_drive" : null),
          title: input.title,
          uri: input.uri ?? null,
          status: sourceStatus,
          assetId: input.assetId ?? null,
          externalId: input.externalId ?? null,
          metadata: input.metadata ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);

      if (bodyText) {
        await upsertItem(source, {
          externalId: input.externalId ?? source.id,
          title: input.title,
          uri: input.uri ?? null,
          mimeType: "text/markdown",
          bodyText,
          metadata: input.metadata ?? null,
        });
      }

      const countsBySourceId = await countSourceChildren(db, [source.id]);
      return toSource((await sourceById(companyId, source.id)) ?? source, countsBySourceId);
    },

    deleteSource: async (companyId: string, sourceId: string) => {
      const source = await sourceById(companyId, sourceId);
      if (!source) return null;
      await db.delete(contextSources).where(eq(contextSources.id, sourceId));
      return toSource(source);
    },

    upsertSourceItem: async (
      companyId: string,
      sourceId: string,
      input: ContextSourceUpsertItemRequest,
    ) => {
      const source = await sourceById(companyId, sourceId);
      if (!source) throw unprocessable("Context source does not belong to this company.");
      return upsertItem(source, input);
    },

    markSourceSyncing: async (companyId: string, sourceId: string) => {
      const source = await sourceById(companyId, sourceId);
      if (!source) return null;
      const now = new Date();
      await db
        .update(contextSources)
        .set({ status: "syncing", statusMessage: null, updatedAt: now })
        .where(eq(contextSources.id, sourceId));
      return db
        .insert(contextSourceSyncRuns)
        .values({
          companyId,
          projectId: source.projectId,
          sourceId,
          status: "running",
          startedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    setSourceStatus: async (
      companyId: string,
      sourceId: string,
      status: ContextSourceStatus,
      statusMessage?: string | null,
    ) => {
      const source = await sourceById(companyId, sourceId);
      if (!source) return null;
      const now = new Date();
      await db
        .update(contextSources)
        .set({
          status,
          statusMessage: statusMessage ?? null,
          lastSyncedAt: status === "ready" ? now : source.lastSyncedAt,
          updatedAt: now,
        })
        .where(eq(contextSources.id, sourceId));
      const countsBySourceId = await countSourceChildren(db, [sourceId]);
      const updated = await sourceById(companyId, sourceId);
      return updated ? toSource(updated, countsBySourceId) : null;
    },

    reindexSource: async (companyId: string, sourceId: string) => {
      const source = await sourceById(companyId, sourceId);
      if (!source) return null;
      const startedAt = new Date();
      const syncRun = await db
        .insert(contextSourceSyncRuns)
        .values({
          companyId,
          projectId: source.projectId,
          sourceId,
          status: "running",
          startedAt,
        })
        .returning()
        .then((rows) => rows[0]!);

      let chunkCount = 0;
      const items = await db
        .select()
        .from(contextSourceItems)
        .where(and(eq(contextSourceItems.companyId, companyId), eq(contextSourceItems.sourceId, sourceId)));
      for (const item of items) {
        if (item.status === "ready" && item.bodyText) {
          chunkCount += await replaceChunksForItem(item);
        }
      }

      const now = new Date();
      const statusMessage =
        source.sourceType === "google_drive" && items.length === 0
          ? "Google Drive folder is linked. Configure a Google Drive connector plugin to import files."
          : null;
      await db
        .update(contextSources)
        .set({
          status: "ready",
          statusMessage,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(contextSources.id, sourceId));
      await db
        .update(contextSourceSyncRuns)
        .set({
          status: "succeeded",
          finishedAt: now,
          itemCount: items.length,
          chunkCount,
        })
        .where(eq(contextSourceSyncRuns.id, syncRun.id));
      const countsBySourceId = await countSourceChildren(db, [sourceId]);
      const updated = await sourceById(companyId, sourceId);
      return updated ? toSource(updated, countsBySourceId) : null;
    },

    search: async (
      companyId: string,
      projectId: string,
      query: string,
      limit = DEFAULT_MAX_CHUNKS,
    ): Promise<ContextSourceSearchResult[]> => {
      const q = normalizeText(query).slice(0, MAX_QUERY_CHARS);
      if (!q) return [];
      const cappedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
      const searchQueryText = buildSearchQueryText(q);
      if (!searchQueryText) return [];
      const tsQuery = sql`to_tsquery('english', ${searchQueryText})`;
      const rank = sql<number>`ts_rank(to_tsvector('english', ${contextSourceChunks.content}), ${tsQuery})`;

      const rows = await db
        .select({
          chunkId: contextSourceChunks.id,
          sourceId: contextSourceChunks.sourceId,
          itemId: contextSourceChunks.itemId,
          sourceTitle: contextSources.title,
          itemTitle: contextSourceItems.title,
          uri: contextSourceItems.uri,
          content: contextSourceChunks.content,
          rank,
        })
        .from(contextSourceChunks)
        .innerJoin(contextSourceItems, eq(contextSourceChunks.itemId, contextSourceItems.id))
        .innerJoin(contextSources, eq(contextSourceChunks.sourceId, contextSources.id))
        .where(
          and(
            eq(contextSourceChunks.companyId, companyId),
            eq(contextSourceChunks.projectId, projectId),
            sql`to_tsvector('english', ${contextSourceChunks.content}) @@ ${tsQuery}`,
          ),
        )
        .orderBy(desc(rank), asc(contextSourceChunks.chunkIndex))
        .limit(cappedLimit);

      return rows.map((row) => ({
        chunkId: row.chunkId,
        sourceId: row.sourceId,
        itemId: row.itemId,
        sourceTitle: row.sourceTitle,
        itemTitle: row.itemTitle,
        uri: row.uri ?? null,
        content: row.content,
        rank: Number(row.rank ?? 0),
      }));
    },

    buildBundle: async (input: {
      companyId: string;
      projectId: string;
      issueId?: string | null;
      query?: string | null;
    }): Promise<ProjectContextBundle | null> => {
      const project = await getProject(input.companyId, input.projectId);
      if (!project) return null;
      const profile = await (async () => {
        const row = await getProfileRow(input.companyId, input.projectId);
        return row ? toProfile(row) : defaultProfile(input.companyId, input.projectId);
      })();
      const warnings: string[] = [];
      const queryParts: string[] = [];
      const explicitQuery = asString(input.query);
      if (explicitQuery) queryParts.push(explicitQuery);

      if (input.issueId) {
        const issue = await db
          .select({
            title: issues.title,
            description: issues.description,
          })
          .from(issues)
          .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
          .then((rows) => rows[0] ?? null);
        if (issue) {
          queryParts.push(issue.title);
          if (issue.description) queryParts.push(issue.description);
        }
        const comments = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId)))
          .orderBy(desc(issueComments.createdAt))
          .limit(5);
        queryParts.push(...comments.map((comment) => comment.body));
      }

      const query = queryParts.join("\n\n").slice(0, MAX_QUERY_CHARS).trim() || null;
      const searchResults =
        profile.retrievalEnabled && query
          ? await projectContextService(db).search(input.companyId, input.projectId, query, profile.maxChunks)
          : [];

      let remaining = sanitizeLimit(profile.maxBundleChars, DEFAULT_MAX_BUNDLE_CHARS, 100_000);
      const sources = [];
      for (const result of searchResults) {
        if (remaining <= 0) {
          warnings.push("Project context source snippets were truncated by the bundle character limit.");
          break;
        }
        const excerpt = result.content.slice(0, Math.min(MAX_EXCERPT_CHARS, remaining));
        remaining -= excerpt.length;
        sources.push({
          sourceId: result.sourceId,
          itemId: result.itemId,
          chunkId: result.chunkId,
          sourceTitle: result.sourceTitle,
          itemTitle: result.itemTitle,
          uri: result.uri,
          excerpt,
        });
      }

      if (
        !profile.goalMarkdown.trim() &&
        !profile.instructionsMarkdown.trim() &&
        profile.defaultSkillKeys.length === 0 &&
        sources.length === 0
      ) {
        return null;
      }

      return {
        companyId: input.companyId,
        projectId: input.projectId,
        goalMarkdown: profile.goalMarkdown,
        instructionsMarkdown: profile.instructionsMarkdown,
        defaultSkillKeys: profile.defaultSkillKeys,
        sources,
        warnings,
        generatedAt: new Date().toISOString(),
        query,
      };
    },
  };
}
