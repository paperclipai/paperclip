import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, externalObjectMentions, externalObjects, issueComments, issueDocuments, issues, plugins } from "@paperclipai/db";
import {
  formatExternalObjectMentionSourceLabel,
  type ExternalObjectCanonicalUrl,
  type ExternalObjectLivenessState,
  type ExternalObjectMentionConfidence,
  type ExternalObjectMentionSourceKind,
  type ExternalObjectStatusCategory,
  type ExternalObjectStatusTone,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { extractExternalObjectCanonicalUrls } from "@paperclipai/shared/external-objects-server";
import type { PluginExternalObjectRecordSnapshot, PluginExternalObjectResolveResult } from "@paperclipai/plugin-sdk";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { createGitHubExternalObjectProvider, type GitHubExternalObjectProviderOptions } from "./github-external-object-provider.js";
import { publishLiveEvent } from "./live-events.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export interface ExternalObjectSourceContext {
  companyId: string;
  sourceIssueId: string;
  sourceKind: ExternalObjectMentionSourceKind;
  sourceRecordId: string | null;
  documentKey: string | null;
  propertyKey: string | null;
}

export interface ExternalObjectDetection {
  canonical: ExternalObjectCanonicalUrl;
  detectorKey: string;
  providerKey: string;
  objectType: string;
  externalId: string;
  displayKey?: string | null;
  iconKey?: string | null;
  displayTitle?: string | null;
  confidence?: ExternalObjectMentionConfidence;
  pluginId?: string | null;
}

export interface ExternalObjectDetector {
  key: string;
  detect(input: {
    companyId: string;
    urls: ExternalObjectCanonicalUrl[];
    sourceContext: ExternalObjectSourceContext;
  }): Promise<ExternalObjectDetection[]> | ExternalObjectDetection[];
}

export interface ExternalObjectResolverSnapshot {
  displayKey?: string | null;
  iconKey?: string | null;
  displayTitle?: string | null;
  statusKey?: string | null;
  statusLabel?: string | null;
  statusIconKey?: string | null;
  statusCategory: ExternalObjectStatusCategory;
  statusTone: ExternalObjectStatusTone;
  isTerminal?: boolean;
  data?: Record<string, unknown>;
  remoteVersion?: string | null;
  etag?: string | null;
  ttlSeconds?: number;
}

export type ExternalObjectResolveResult =
  | { ok: true; snapshot: ExternalObjectResolverSnapshot }
  | {
      ok: false;
      liveness: Extract<ExternalObjectLivenessState, "auth_required" | "unreachable">;
      errorCode: string;
      errorMessage?: string | null;
      retryAfterSeconds?: number;
    };

export interface ExternalObjectResolver {
  providerKey: string;
  objectType?: string;
  resolve(input: {
    companyId: string;
    object: ExternalObjectRecord;
  }): Promise<ExternalObjectResolveResult>;
}

type ExternalObjectRecord = typeof externalObjects.$inferSelect;
type ExternalObjectMentionRecord = typeof externalObjectMentions.$inferSelect;

const DEFAULT_REFRESH_TTL_SECONDS = 300;
const DEFAULT_RETRY_AFTER_SECONDS = 300;

function sourceWhere(input: ExternalObjectSourceContext) {
  const conditions = [
    eq(externalObjectMentions.companyId, input.companyId),
    eq(externalObjectMentions.sourceIssueId, input.sourceIssueId),
    eq(externalObjectMentions.sourceKind, input.sourceKind),
  ];
  if (input.sourceRecordId) {
    conditions.push(eq(externalObjectMentions.sourceRecordId, input.sourceRecordId));
  } else {
    conditions.push(isNull(externalObjectMentions.sourceRecordId));
  }
  if (input.documentKey) {
    conditions.push(eq(externalObjectMentions.documentKey, input.documentKey));
  } else {
    conditions.push(isNull(externalObjectMentions.documentKey));
  }
  if (input.propertyKey) {
    conditions.push(eq(externalObjectMentions.propertyKey, input.propertyKey));
  } else {
    conditions.push(isNull(externalObjectMentions.propertyKey));
  }
  return and(...conditions);
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + Math.max(1, seconds) * 1000);
}

function visibleLiveness(object: ExternalObjectRecord, now = new Date()): ExternalObjectLivenessState {
  if (object.liveness === "fresh" && object.nextRefreshAt && object.nextRefreshAt <= now) {
    return "stale";
  }
  return object.liveness;
}

function objectChanged(before: ExternalObjectRecord, after: ExternalObjectRecord) {
  return (
    before.statusKey !== after.statusKey ||
    before.statusLabel !== after.statusLabel ||
    before.statusIconKey !== after.statusIconKey ||
    before.statusCategory !== after.statusCategory ||
    before.statusTone !== after.statusTone ||
    before.isTerminal !== after.isTerminal
  );
}

function sanitizeErrorMessage(message: string | null | undefined) {
  if (!message) return null;
  return message
    .replace(/https?:\/\/[^\s<>()]+/gi, "[redacted-url]")
    .replace(/\b(token|key|secret|authorization|bearer)=\S+/gi, "$1=[redacted]");
}

function genericUrlDetector(): ExternalObjectDetector {
  return {
    key: "generic-url",
    detect({ urls }) {
      return urls.map((canonical) => ({
        canonical,
        detectorKey: "generic-url",
        providerKey: "url",
        objectType: "link",
        externalId: canonical.canonicalIdentityHash,
        displayTitle: canonical.sanitizedDisplayUrl,
        confidence: "possible",
      }));
    },
  };
}

export function createExternalObjectDetectorRegistry(detectors: ExternalObjectDetector[] = []) {
  const entries = [...detectors, genericUrlDetector()];

  async function detect(input: {
    companyId: string;
    urls: ExternalObjectCanonicalUrl[];
    sourceContext: ExternalObjectSourceContext;
  }) {
    const claimed = new Set<string>();
    const detections: ExternalObjectDetection[] = [];
    for (const detector of entries) {
      const remaining = input.urls.filter((url) => !claimed.has(url.canonicalIdentityHash));
      if (remaining.length === 0) break;
      try {
        const detected = await detector.detect({ ...input, urls: remaining });
        for (const detection of detected) {
          if (claimed.has(detection.canonical.canonicalIdentityHash)) continue;
          claimed.add(detection.canonical.canonicalIdentityHash);
          detections.push({ ...detection, detectorKey: detection.detectorKey || detector.key });
        }
      } catch (err) {
        logger.warn({ err, detectorKey: detector.key }, "external object detector failed");
      }
    }
    return detections;
  }

  return { detect };
}

export function createExternalObjectResolverRegistry(resolvers: ExternalObjectResolver[] = []) {
  function find(object: Pick<ExternalObjectRecord, "providerKey" | "objectType">) {
    return resolvers.find(
      (resolver) =>
        resolver.providerKey === object.providerKey &&
        (!resolver.objectType || resolver.objectType === object.objectType),
    ) ?? null;
  }
  return { find };
}

function manifestProvidesObject(
  manifest: PaperclipPluginManifestV1,
  object: Pick<ExternalObjectRecord, "providerKey" | "objectType">,
) {
  return (manifest.objectReferences ?? []).some(
    (provider) =>
      provider.providerKey === object.providerKey &&
      provider.objectTypes.includes(object.objectType),
  );
}

function objectSnapshot(object: ExternalObjectRecord): PluginExternalObjectRecordSnapshot {
  return {
    id: object.id,
    companyId: object.companyId,
    providerKey: object.providerKey,
    objectType: object.objectType,
    externalId: object.externalId,
    sanitizedCanonicalUrl: object.sanitizedCanonicalUrl,
    canonicalIdentityHash: object.canonicalIdentityHash,
    displayKey: object.displayKey,
    iconKey: object.iconKey,
    displayTitle: object.displayTitle,
    statusKey: object.statusKey,
    statusLabel: object.statusLabel,
    statusIconKey: object.statusIconKey,
    statusCategory: object.statusCategory,
    statusTone: object.statusTone,
    liveness: object.liveness,
    isTerminal: object.isTerminal,
    data: object.data as Record<string, unknown>,
    remoteVersion: object.remoteVersion,
    etag: object.etag,
  };
}

async function readyObjectReferencePlugins(db: Db) {
  return db
    .select({
      id: plugins.id,
      pluginKey: plugins.pluginKey,
      manifestJson: plugins.manifestJson,
    })
    .from(plugins)
    .where(eq(plugins.status, "ready"))
    .orderBy(asc(plugins.installOrder))
    .then((rows) =>
      rows.filter((row) => (row.manifestJson.objectReferences?.length ?? 0) > 0),
    );
}

function createPluginProviderDetector(
  db: Db,
  pluginWorkerManager: PluginWorkerManager,
): ExternalObjectDetector {
  return {
    key: "plugin-object-reference-providers",
    async detect(input) {
      const providers = await readyObjectReferencePlugins(db);
      const detections: ExternalObjectDetection[] = [];

      for (const provider of providers) {
        const manifest = provider.manifestJson;
        if (!manifest.capabilities.includes("external.objects.detect")) continue;
        try {
          const result = await pluginWorkerManager.call(provider.id, "detectExternalObjects", {
            companyId: input.companyId,
            urls: input.urls.map((url) => ({
              sanitizedCanonicalUrl: url.sanitizedCanonicalUrl,
              sanitizedDisplayUrl: url.sanitizedDisplayUrl,
              canonicalIdentityHash: url.canonicalIdentityHash,
              canonicalIdentity: url.canonicalIdentity as unknown as Record<string, unknown>,
              redactedMatchedText: url.redactedMatchedText,
            })),
            sourceContext: input.sourceContext,
          });
          const urlsByHash = new Map(input.urls.map((url) => [url.canonicalIdentityHash, url]));
          const declaredProviderKeys = new Set((manifest.objectReferences ?? []).map((entry) => entry.providerKey));

          for (const detection of result.detections ?? []) {
            const canonical = urlsByHash.get(detection.urlIdentityHash);
            if (!canonical) continue;
            if (!declaredProviderKeys.has(detection.providerKey)) continue;
            const declaration = (manifest.objectReferences ?? []).find((entry) => entry.providerKey === detection.providerKey);
            if (!declaration?.objectTypes.includes(detection.objectType)) continue;
            detections.push({
              canonical,
              detectorKey: `${provider.pluginKey}:${detection.providerKey}`,
              providerKey: detection.providerKey,
              objectType: detection.objectType,
              externalId: detection.externalId,
              displayKey: detection.displayKey,
              iconKey: detection.iconKey,
              displayTitle: detection.displayTitle,
              confidence: detection.confidence ?? "exact",
              pluginId: provider.id,
            });
          }
        } catch (err) {
          logger.warn(
            { err, pluginId: provider.id, pluginKey: provider.pluginKey },
            "plugin external object detector failed",
          );
        }
      }

      return detections;
    },
  };
}

async function resolveViaPluginProvider(
  db: Db,
  pluginWorkerManager: PluginWorkerManager | undefined,
  object: ExternalObjectRecord,
): Promise<PluginExternalObjectResolveResult | null> {
  if (!pluginWorkerManager) return null;
  const providers = await readyObjectReferencePlugins(db);
  for (const provider of providers) {
    const manifest = provider.manifestJson;
    if (!manifest.capabilities.includes("external.objects.read")) continue;
    if (!manifestProvidesObject(manifest, object)) continue;
    try {
      return await pluginWorkerManager.call(provider.id, "resolveExternalObject", {
        companyId: object.companyId,
        providerKey: object.providerKey,
        objectType: object.objectType,
        externalId: object.externalId,
        object: objectSnapshot(object),
      });
    } catch (err) {
      logger.warn(
        { err, pluginId: provider.id, pluginKey: provider.pluginKey, objectId: object.id },
        "plugin external object resolver failed",
      );
      return {
        ok: false,
        liveness: "unreachable",
        errorCode: "plugin_resolver_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return null;
}

export function externalObjectService(
  db: Db,
  opts: {
    detectors?: ExternalObjectDetector[];
    resolvers?: ExternalObjectResolver[];
    pluginWorkerManager?: PluginWorkerManager;
    github?: GitHubExternalObjectProviderOptions | false;
    enabled?: boolean | (() => boolean | Promise<boolean>);
  } = {},
) {
  const githubProvider = opts.github === false ? null : createGitHubExternalObjectProvider(db, opts.github);
  const pluginProviderDetector = opts.pluginWorkerManager
    ? createPluginProviderDetector(db, opts.pluginWorkerManager)
    : null;
  const detectorRegistry = createExternalObjectDetectorRegistry([
    ...(pluginProviderDetector ? [pluginProviderDetector] : []),
    ...(opts.detectors ?? []),
    ...(githubProvider ? [githubProvider.detector] : []),
  ]);
  const resolverRegistry = createExternalObjectResolverRegistry([
    ...(opts.resolvers ?? []),
    ...(githubProvider?.resolvers ?? []),
  ]);

  async function isEnabled() {
    if (typeof opts.enabled === "function") return await opts.enabled();
    return opts.enabled ?? true;
  }

  function emptySummary() {
    return summarizeObjectPayloads([]);
  }

  async function issueById(issueId: string, dbOrTx: any = db) {
    return dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows: Array<{ id: string; companyId: string; title: string; description: string | null }>) => rows[0] ?? null);
  }

  async function upsertObjectFromDetection(
    companyId: string,
    detection: ExternalObjectDetection,
    dbOrTx: any,
  ): Promise<ExternalObjectRecord> {
    const now = new Date();
    const canonical = detection.canonical;
    const values = {
      companyId,
      providerKey: detection.providerKey,
      pluginId: detection.pluginId ?? null,
      objectType: detection.objectType,
      externalId: detection.externalId,
      sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
      canonicalIdentityHash: canonical.canonicalIdentityHash,
      displayKey: detection.displayKey ?? null,
      iconKey: detection.iconKey ?? null,
      displayTitle: detection.displayTitle ?? canonical.sanitizedDisplayUrl,
      nextRefreshAt: now,
      updatedAt: now,
    };
    const inserted = await dbOrTx
      .insert(externalObjects)
      .values(values)
      .onConflictDoUpdate({
        target: [
          externalObjects.companyId,
          externalObjects.providerKey,
          externalObjects.objectType,
          externalObjects.externalId,
        ],
        set: {
          sanitizedCanonicalUrl: values.sanitizedCanonicalUrl,
          canonicalIdentityHash: values.canonicalIdentityHash,
          displayKey: values.displayKey,
          iconKey: values.iconKey,
          displayTitle: values.displayTitle,
          nextRefreshAt: sql`coalesce(${externalObjects.nextRefreshAt}, now())`,
          updatedAt: now,
        },
      })
      .returning();
    return inserted[0]!;
  }

  async function replaceSourceMentions(
    input: ExternalObjectSourceContext & { text: string | null | undefined },
    dbOrTx: any = db,
  ) {
    const urls = extractExternalObjectCanonicalUrls(input.text ?? "");
    await dbOrTx.delete(externalObjectMentions).where(sourceWhere(input));
    if (urls.length === 0) return;

    const detections = await detectorRegistry.detect({
      companyId: input.companyId,
      urls,
      sourceContext: input,
    });
    if (detections.length === 0) return;

    const seen = new Set<string>();
    const values: Array<typeof externalObjectMentions.$inferInsert> = [];
    for (const detection of detections) {
      const canonicalHash = detection.canonical.canonicalIdentityHash;
      const sourceKey = `${detection.providerKey}:${detection.objectType}:${canonicalHash}`;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      const object = await upsertObjectFromDetection(input.companyId, detection, dbOrTx);
      values.push({
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        sourceKind: input.sourceKind,
        sourceRecordId: input.sourceRecordId,
        documentKey: input.documentKey,
        propertyKey: input.propertyKey,
        matchedTextRedacted: detection.canonical.redactedMatchedText,
        sanitizedDisplayUrl: detection.canonical.sanitizedDisplayUrl,
        canonicalIdentityHash: canonicalHash,
        canonicalIdentity: detection.canonical.canonicalIdentity as unknown as Record<string, unknown>,
        objectId: object.id,
        providerKey: detection.providerKey,
        detectorKey: detection.detectorKey,
        objectType: detection.objectType,
        confidence: detection.confidence ?? "exact",
        createdByPluginId: detection.pluginId ?? null,
      });
    }
    if (values.length > 0) {
      await dbOrTx.insert(externalObjectMentions).values(values);
    }
  }

  async function syncIssue(issueId: string, dbOrTx: any = db) {
    if (!(await isEnabled())) return;
    const runSync = async (tx: any) => {
      const issue = await issueById(issueId, tx);
      if (!issue) throw notFound("Issue not found");
      await replaceSourceMentions({
        companyId: issue.companyId,
        sourceIssueId: issue.id,
        sourceKind: "title",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
        text: issue.title,
      }, tx);
      await replaceSourceMentions({
        companyId: issue.companyId,
        sourceIssueId: issue.id,
        sourceKind: "description",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
        text: issue.description,
      }, tx);
    };
    return dbOrTx === db ? db.transaction(runSync) : runSync(dbOrTx);
  }

  async function syncComment(commentId: string, dbOrTx: any = db) {
    const runSync = async (tx: any) => {
      if (!(await isEnabled())) return;
      const comment = await tx
        .select({
          id: issueComments.id,
          companyId: issueComments.companyId,
          issueId: issueComments.issueId,
          body: issueComments.body,
        })
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows: Array<{ id: string; companyId: string; issueId: string; body: string }>) => rows[0] ?? null);
      if (!comment) {
        await tx
          .delete(externalObjectMentions)
          .where(and(eq(externalObjectMentions.sourceKind, "comment"), eq(externalObjectMentions.sourceRecordId, commentId)));
        return;
      }
      await replaceSourceMentions({
        companyId: comment.companyId,
        sourceIssueId: comment.issueId,
        sourceKind: "comment",
        sourceRecordId: comment.id,
        documentKey: null,
        propertyKey: null,
        text: comment.body,
      }, tx);
    };
    return dbOrTx === db ? db.transaction(runSync) : runSync(dbOrTx);
  }

  async function syncDocument(documentId: string, dbOrTx: any = db) {
    const runSync = async (tx: any) => {
      if (!(await isEnabled())) return;
      const document = await tx
        .select({
          documentId: documents.id,
          companyId: documents.companyId,
          issueId: issueDocuments.issueId,
          key: issueDocuments.key,
          body: documents.latestBody,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(eq(documents.id, documentId))
        .then((rows: Array<{ documentId: string; companyId: string; issueId: string; key: string; body: string }>) => rows[0] ?? null);
      if (!document) {
        await tx
          .delete(externalObjectMentions)
          .where(and(eq(externalObjectMentions.sourceKind, "document"), eq(externalObjectMentions.sourceRecordId, documentId)));
        return;
      }
      await replaceSourceMentions({
        companyId: document.companyId,
        sourceIssueId: document.issueId,
        sourceKind: "document",
        sourceRecordId: document.documentId,
        documentKey: document.key,
        propertyKey: null,
        text: document.body,
      }, tx);
    };
    return dbOrTx === db ? db.transaction(runSync) : runSync(dbOrTx);
  }

  async function safeSync(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err }, `external object ${label} sync failed`);
    }
  }

  async function syncIssueSafely(issueId: string) {
    await safeSync("issue", () => syncIssue(issueId));
  }

  async function syncCommentSafely(commentId: string, dbOrTx: any = db) {
    await safeSync("comment", () => syncComment(commentId, dbOrTx));
  }

  async function syncDocumentSafely(documentId: string) {
    await safeSync("document", () => syncDocument(documentId));
  }

  function toObjectPayload(object: ExternalObjectRecord, now = new Date()) {
    return {
      ...object,
      liveness: visibleLiveness(object, now),
    };
  }

  async function listForIssue(issueId: string) {
    if (!(await isEnabled())) return [];
    const issue = await issueById(issueId);
    if (!issue) throw notFound("Issue not found");
    const rows = await db
      .select({
        mention: externalObjectMentions,
        object: externalObjects,
      })
      .from(externalObjectMentions)
      .leftJoin(externalObjects, eq(externalObjectMentions.objectId, externalObjects.id))
      .where(and(
        eq(externalObjectMentions.companyId, issue.companyId),
        eq(externalObjectMentions.sourceIssueId, issue.id),
      ))
      .orderBy(asc(externalObjectMentions.sourceKind), asc(externalObjectMentions.createdAt));
    const now = new Date();
    const grouped = new Map<string, {
      object: ReturnType<typeof toObjectPayload> | null;
      mentions: ExternalObjectMentionRecord[];
      mentionCount: number;
      sourceLabels: string[];
    }>();
    for (const row of rows) {
      const key = row.object?.id ?? `mention:${row.mention.id}`;
      const existing = grouped.get(key) ?? {
        object: row.object ? toObjectPayload(row.object, now) : null,
        mentions: [],
        mentionCount: 0,
        sourceLabels: [],
      };
      existing.mentions.push(row.mention);
      existing.mentionCount += 1;
      const label = formatExternalObjectMentionSourceLabel({
        sourceKind: row.mention.sourceKind,
        documentKey: row.mention.documentKey,
        propertyKey: row.mention.propertyKey,
      });
      if (!existing.sourceLabels.includes(label)) existing.sourceLabels.push(label);
      grouped.set(key, existing);
    }
    return [...grouped.values()];
  }

  function summarizeObjects(objects: Array<ReturnType<typeof toObjectPayload>>) {
    const byStatusCategory: Record<string, number> = {};
    const byLiveness: Record<string, number> = {};
    let highestSeverity: ExternalObjectStatusTone = "neutral";
    const severityRank: Record<ExternalObjectStatusTone, number> = {
      neutral: 0,
      muted: 0,
      success: 1,
      info: 2,
      warning: 3,
      danger: 4,
    };
    for (const object of objects) {
      byStatusCategory[object.statusCategory] = (byStatusCategory[object.statusCategory] ?? 0) + 1;
      byLiveness[object.liveness] = (byLiveness[object.liveness] ?? 0) + 1;
      const livenessTone = object.liveness === "auth_required" || object.liveness === "unreachable"
        ? "danger"
        : object.liveness === "stale"
        ? "warning"
        : object.statusTone;
      if (severityRank[livenessTone] > severityRank[highestSeverity]) highestSeverity = livenessTone;
    }
    return {
      total: objects.length,
      byStatusCategory,
      byLiveness,
      highestSeverity,
      staleCount: byLiveness.stale ?? 0,
      authRequiredCount: byLiveness.auth_required ?? 0,
      unreachableCount: byLiveness.unreachable ?? 0,
    };
  }

  function summarizeObjectPayloads(objects: Array<ReturnType<typeof toObjectPayload>>, objectLimit = objects.length) {
    return {
      ...summarizeObjects(objects),
      objects: objects.slice(0, objectLimit).map((object) => ({
        id: object.id,
        providerKey: object.providerKey,
        objectType: object.objectType,
        displayKey: object.displayKey,
        iconKey: object.iconKey,
        displayTitle: object.displayTitle,
        statusIconKey: object.statusIconKey,
        statusCategory: object.statusCategory,
        statusTone: object.statusTone,
        liveness: object.liveness,
        isTerminal: object.isTerminal,
      })),
    };
  }

  async function getIssueSummary(issueId: string) {
    if (!(await isEnabled())) return emptySummary();
    const groups = await listForIssue(issueId);
    const objects = groups.flatMap((group) => (group.object ? [group.object] : []));
    return summarizeObjectPayloads(objects);
  }

  async function getIssueSummaries(companyId: string, issueIds: string[]) {
    if (!(await isEnabled())) return new Map<string, ReturnType<typeof summarizeObjectPayloads>>();
    const uniqueIssueIds = [...new Set(issueIds)].filter((id) => id.length > 0);
    const summaries = new Map<string, ReturnType<typeof summarizeObjectPayloads>>();
    if (uniqueIssueIds.length === 0) return summaries;

    const rows = await db
      .select({
        issueId: externalObjectMentions.sourceIssueId,
        object: externalObjects,
      })
      .from(externalObjectMentions)
      .innerJoin(externalObjects, eq(externalObjectMentions.objectId, externalObjects.id))
      .where(and(
        eq(externalObjectMentions.companyId, companyId),
        inArray(externalObjectMentions.sourceIssueId, uniqueIssueIds),
      ));

    const now = new Date();
    const objectsByIssueId = new Map<string, Map<string, ReturnType<typeof toObjectPayload>>>();
    for (const row of rows) {
      const issueObjects = objectsByIssueId.get(row.issueId) ?? new Map<string, ReturnType<typeof toObjectPayload>>();
      issueObjects.set(row.object.id, toObjectPayload(row.object, now));
      objectsByIssueId.set(row.issueId, issueObjects);
    }

    for (const [issueId, issueObjects] of objectsByIssueId) {
      const objects = [...issueObjects.values()];
      if (objects.length > 0) summaries.set(issueId, summarizeObjectPayloads(objects));
    }
    return summaries;
  }

  async function getProjectSummary(projectId: string) {
    if (!(await isEnabled())) return emptySummary();
    const projectIssues = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"])));
    if (projectIssues.length === 0) return { ...summarizeObjects([]), objects: [] };
    const companyIds = new Set(projectIssues.map((issue) => issue.companyId));
    if (companyIds.size !== 1) return { ...summarizeObjects([]), objects: [] };
    const issueIds = projectIssues.map((issue) => issue.id);
    const rows = await db
      .select({ object: externalObjects })
      .from(externalObjectMentions)
      .innerJoin(externalObjects, eq(externalObjectMentions.objectId, externalObjects.id))
      .where(and(
        eq(externalObjectMentions.companyId, projectIssues[0]!.companyId),
        inArray(externalObjectMentions.sourceIssueId, issueIds),
      ));
    const now = new Date();
    const objectsById = new Map<string, ReturnType<typeof toObjectPayload>>();
    for (const row of rows) objectsById.set(row.object.id, toObjectPayload(row.object, now));
    const objects = [...objectsById.values()];
    return summarizeObjectPayloads(objects, 25);
  }

  async function refreshObject(
    objectId: string,
    input: {
      companyId: string;
      actor?: Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;
      force?: boolean;
      now?: Date;
    },
  ) {
    const now = input.now ?? new Date();
    const object = await db
      .select()
      .from(externalObjects)
      .where(and(eq(externalObjects.id, objectId), eq(externalObjects.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!object) throw notFound("External object not found");
    if (!input.force && object.nextRefreshAt && object.nextRefreshAt > now) {
      return { object: toObjectPayload(object, now), refreshed: false, reason: "backoff" as const };
    }

    const pluginResult = await resolveViaPluginProvider(db, opts.pluginWorkerManager, object);
    const resolver = pluginResult ? null : resolverRegistry.find(object);
    if (!pluginResult && !resolver) {
      const [updated] = await db
        .update(externalObjects)
        .set({
          liveness: visibleLiveness(object, now) === "fresh" ? "stale" : object.liveness,
          nextRefreshAt: addSeconds(now, DEFAULT_RETRY_AFTER_SECONDS),
          updatedAt: now,
        })
        .where(and(eq(externalObjects.id, object.id), eq(externalObjects.companyId, object.companyId)))
        .returning();
      return { object: toObjectPayload(updated ?? object, now), refreshed: false, reason: "no_resolver" as const };
    }

    const result = pluginResult ?? await resolver!.resolve({ companyId: object.companyId, object });
    if (!result.ok) {
      const [updated] = await db
        .update(externalObjects)
        .set({
          liveness: result.liveness,
          lastErrorAt: now,
          lastErrorCode: result.errorCode,
          lastErrorMessage: sanitizeErrorMessage(result.errorMessage),
          nextRefreshAt: addSeconds(now, result.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS),
          updatedAt: now,
        })
        .where(and(eq(externalObjects.id, object.id), eq(externalObjects.companyId, object.companyId)))
        .returning();
      publishLiveEvent({
        companyId: object.companyId,
        type: "external_object.updated",
        payload: { objectId: object.id, liveness: result.liveness },
      });
      return { object: toObjectPayload(updated ?? object, now), refreshed: true, reason: result.liveness };
    }

    const snapshot = result.snapshot;
    const patch = {
      displayKey: snapshot.displayKey ?? object.displayKey,
      iconKey: snapshot.iconKey ?? object.iconKey,
      displayTitle: snapshot.displayTitle ?? object.displayTitle,
      statusKey: snapshot.statusKey ?? object.statusKey,
      statusLabel: snapshot.statusLabel ?? object.statusLabel,
      statusIconKey: snapshot.statusIconKey ?? object.statusIconKey,
      statusCategory: snapshot.statusCategory,
      statusTone: snapshot.statusTone,
      isTerminal: snapshot.isTerminal ?? object.isTerminal,
      data: snapshot.data ?? object.data,
      remoteVersion: snapshot.remoteVersion ?? object.remoteVersion,
      etag: snapshot.etag ?? object.etag,
      liveness: "fresh" as ExternalObjectLivenessState,
      lastResolvedAt: now,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextRefreshAt: addSeconds(now, snapshot.ttlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS),
      updatedAt: now,
    };
    const [updated] = await db
      .update(externalObjects)
      .set({
        ...patch,
        lastChangedAt: objectChanged(object, { ...object, ...patch }) ? now : object.lastChangedAt,
      })
      .where(and(eq(externalObjects.id, object.id), eq(externalObjects.companyId, object.companyId)))
      .returning();
    const next = updated ?? object;
    if (objectChanged(object, next) && input.actor) {
      await logActivity(db, {
        companyId: object.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "external_object.status_changed",
        entityType: "external_object",
        entityId: object.id,
        details: {
          providerKey: object.providerKey,
          objectType: object.objectType,
          statusCategory: next.statusCategory,
          statusLabel: next.statusLabel,
          _previous: {
            statusCategory: object.statusCategory,
            statusLabel: object.statusLabel,
          },
        },
      });
    }
    publishLiveEvent({
      companyId: object.companyId,
      type: "external_object.updated",
      payload: { objectId: object.id, statusCategory: next.statusCategory, liveness: next.liveness },
    });
    return { object: toObjectPayload(next, now), refreshed: true, reason: "resolved" as const };
  }

  async function refreshIssueObjects(issueId: string, input: {
    companyId: string;
    objectIds?: string[];
    actor?: Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;
  }) {
    if (!(await isEnabled())) return [];
    const groups = await listForIssue(issueId);
    const objectIds = groups
      .flatMap((group) => (group.object ? [group.object.id] : []))
      .filter((id) => !input.objectIds || input.objectIds.includes(id));
    const results = [];
    for (const objectId of objectIds) {
      results.push(await refreshObject(objectId, { companyId: input.companyId, actor: input.actor }));
    }
    return results;
  }

  async function refreshDueObjects(companyId: string, limit = 50, now = new Date()) {
    if (!(await isEnabled())) return [];
    const due = await db
      .select({ id: externalObjects.id })
      .from(externalObjects)
      .where(
        and(
          eq(externalObjects.companyId, companyId),
          eq(externalObjects.isTerminal, false),
          lte(externalObjects.nextRefreshAt, now),
        ),
      )
      .limit(limit);
    const results = [];
    for (const row of due) {
      results.push(await refreshObject(row.id, {
        companyId,
        actor: { actorType: "system", actorId: "external-object-resolver", agentId: null, runId: null },
        now,
      }));
    }
    return results;
  }

  return {
    syncIssue,
    syncComment,
    syncDocument,
    syncIssueSafely,
    syncCommentSafely,
    syncDocumentSafely,
    listForIssue,
    getIssueSummary,
    getIssueSummaries,
    getProjectSummary,
    refreshObject,
    refreshIssueObjects,
    refreshDueObjects,
  };
}
