import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { artifacts } from "@paperclipai/db";
import type {
  Artifact,
  ArtifactCreatedByType,
  ArtifactCreatedEvent,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logActivity } from "./activity-log.js";
import { emitArtifactCreated } from "./artifact-events.js";
import { documentService } from "./documents.js";
import { issueService } from "./issues.js";

type DbLike = Pick<Db, "select" | "insert" | "transaction">;

type ApprovalSnapshotActor = {
  type: ArtifactCreatedByType;
  id: string;
};

type ApprovalSnapshotContext = {
  origin: "approval" | "issue_execution_decision";
  approvalId?: string | null;
  executionDecisionId?: string | null;
  executionDecisionStageType?: string | null;
  originRoute?: string | null;
  approvedAt: Date;
  approvedBy: ApprovalSnapshotActor;
};

type SnapshotSource = {
  sourceType: string;
  sourceId: string;
  title: string | null;
  body: string;
  metadata: Record<string, unknown>;
};

function toArtifact(row: typeof artifacts.$inferSelect): Artifact {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    status: "approved",
    version: row.version,
    title: row.title ?? null,
    format: "markdown",
    storageType: "file",
    storagePath: row.storagePath,
    contentHash: row.contentHash,
    createdByType: row.createdByType as Artifact["createdByType"],
    createdById: row.createdById,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sanitizePathSegment(value: string, fallback: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function quoteYaml(value: string | null | undefined) {
  return JSON.stringify(value ?? "");
}

function stringifyMetadataValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return quoteYaml(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return quoteYaml(JSON.stringify(value));
}

function buildFrontmatter(input: Record<string, unknown>) {
  return [
    "---",
    ...Object.entries(input).map(([key, value]) => `${key}: ${stringifyMetadataValue(value)}`),
    "---",
  ].join("\n");
}

function buildApprovedSnapshotMarkdown(input: {
  artifactId: string;
  companyId: string;
  sourceType: string;
  sourceId: string;
  status: "approved";
  version: number;
  title: string | null;
  body: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}) {
  const frontmatter = buildFrontmatter({
    artifactId: input.artifactId,
    companyId: input.companyId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    status: input.status,
    version: input.version,
    format: "markdown",
    contentHash: input.contentHash,
    approvedAt: input.metadata.approvedAt ?? null,
    approvedByType: input.metadata.approvedByType ?? null,
    approvedById: input.metadata.approvedById ?? null,
    issueId: input.metadata.issueId ?? null,
    issueIdentifier: input.metadata.issueIdentifier ?? null,
    approvalId: input.metadata.approvalId ?? null,
    executionDecisionId: input.metadata.executionDecisionId ?? null,
    documentKey: input.metadata.documentKey ?? null,
    documentRevisionId: input.metadata.documentRevisionId ?? null,
    documentRevisionNumber: input.metadata.documentRevisionNumber ?? null,
  });

  const issueLabel = typeof input.metadata.issueIdentifier === "string" && input.metadata.issueIdentifier.trim().length > 0
    ? input.metadata.issueIdentifier
    : input.metadata.issueId;
  const approvalLabel = input.metadata.approvalId ?? input.metadata.executionDecisionId ?? "n/a";

  return [
    frontmatter,
    "",
    `# Approved Snapshot: ${input.title ?? "Untitled document"}`,
    "",
    "## Source",
    `- Issue: ${issueLabel ?? "n/a"}`,
    `- Approval: ${approvalLabel}`,
    `- Company: ${input.companyId}`,
    "",
    "## Approved Content",
    input.body,
    "",
    "## Context Metadata",
    "```json",
    JSON.stringify(input.metadata, null, 2),
    "```",
    "",
  ].join("\n");
}

function buildArtifactContentHash(input: {
  sourceType: string;
  sourceId: string;
  title: string | null;
  body: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      title: input.title ?? null,
      body: input.body,
      format: "markdown",
      status: "approved",
    }))
    .digest("hex");
}

function resolveArtifactStoragePath(input: {
  companyId: string;
  sourceType: string;
  sourceId: string;
  version: number;
}) {
  const versionLabel = `v${String(input.version).padStart(3, "0")}.md`;
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "artifacts",
    "approved",
    sanitizePathSegment(input.companyId, "company"),
    sanitizePathSegment(input.sourceType, "source"),
    sanitizePathSegment(input.sourceId, "artifact"),
    versionLabel,
  );
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}

async function readArtifactContentFromPath(storagePath: string) {
  return fs.readFile(storagePath, "utf8");
}

export function artifactService(db: Db) {
  const issuesSvc = issueService(db);
  const documentsSvc = documentService(db);

  async function ensureApprovedArtifact(
    dbOrTx: DbLike,
    input: {
      companyId: string;
      source: SnapshotSource;
      approvedBy: ApprovalSnapshotActor;
    },
  ) {
    const latest = await dbOrTx
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.companyId, input.companyId),
          eq(artifacts.sourceType, input.source.sourceType),
          eq(artifacts.sourceId, input.source.sourceId),
          eq(artifacts.status, "approved"),
        ),
      )
      .orderBy(desc(artifacts.version))
      .then((rows) => rows[0] ?? null);

    const contentHash = buildArtifactContentHash({
      sourceType: input.source.sourceType,
      sourceId: input.source.sourceId,
      title: input.source.title,
      body: input.source.body,
    });

    if (latest && latest.contentHash === contentHash) {
      return { artifact: toArtifact(latest), created: false };
    }

    const id = randomUUID();
    const version = (latest?.version ?? 0) + 1;
    const storagePath = resolveArtifactStoragePath({
      companyId: input.companyId,
      sourceType: input.source.sourceType,
      sourceId: input.source.sourceId,
      version,
    });
    const markdown = buildApprovedSnapshotMarkdown({
      artifactId: id,
      companyId: input.companyId,
      sourceType: input.source.sourceType,
      sourceId: input.source.sourceId,
      status: "approved",
      version,
      title: input.source.title,
      body: input.source.body,
      contentHash,
      metadata: input.source.metadata,
    });

    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, markdown, "utf8");

    try {
      const inserted = await dbOrTx
        .insert(artifacts)
        .values({
          id,
          companyId: input.companyId,
          sourceType: input.source.sourceType,
          sourceId: input.source.sourceId,
          status: "approved",
          version,
          title: input.source.title,
          format: "markdown",
          storageType: "file",
          storagePath,
          contentHash,
          createdByType: input.approvedBy.type,
          createdById: input.approvedBy.id,
          metadata: input.source.metadata,
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!inserted) {
        throw new Error("Artifact insert returned no row");
      }

      return { artifact: toArtifact(inserted), created: true };
    } catch (error) {
      await fs.rm(storagePath, { force: true }).catch(() => undefined);

      if (!isUniqueViolation(error)) throw error;

      const existing = await dbOrTx
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.companyId, input.companyId),
            eq(artifacts.sourceType, input.source.sourceType),
            eq(artifacts.sourceId, input.source.sourceId),
            eq(artifacts.status, "approved"),
            eq(artifacts.contentHash, contentHash),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) throw error;
      return { artifact: toArtifact(existing), created: false };
    }
  }

  return {
    list: async (
      companyId: string,
      filters?: {
        status?: "approved";
        sourceType?: string;
        sourceId?: string;
        limit?: number;
      },
    ) => {
      const conditions = [eq(artifacts.companyId, companyId)];
      if (filters?.status) conditions.push(eq(artifacts.status, filters.status));
      if (filters?.sourceType) conditions.push(eq(artifacts.sourceType, filters.sourceType));
      if (filters?.sourceId) conditions.push(eq(artifacts.sourceId, filters.sourceId));

      const limit = filters?.limit ?? 100;
      const rows = await db
        .select()
        .from(artifacts)
        .where(and(...conditions))
        .orderBy(desc(artifacts.createdAt))
        .limit(limit);
      return rows.map(toArtifact);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toArtifact(row) : null;
    },

    readContent: async (id: string) => {
      const artifact = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .then((rows) => rows[0] ?? null);
      if (!artifact) throw notFound("Artifact not found");
      return {
        artifact: toArtifact(artifact),
        content: await readArtifactContentFromPath(artifact.storagePath),
      };
    },

    ensureApprovedSnapshotsForIssueDocuments: async (
      input: {
        issueId: string;
        context: ApprovalSnapshotContext;
      },
      dbOrTx: DbLike = db,
    ) => {
      const issue = await issuesSvc.getById(input.issueId);
      if (!issue) throw notFound("Issue not found");
      const documentRecords = await documentsSvc.listIssueDocuments(issue.id);

      // Only durable issue documents are eligible to become immutable approved document artifacts.
      // The issue container and its comments can provide review context, but they are not
      // exported units and do not produce vault-syncable artifacts on their own.
      const sources: SnapshotSource[] = documentRecords
        .filter((doc): doc is typeof doc & { body: string } => typeof doc.body === "string")
        .map((doc) => ({
          sourceType: "issue_document",
          sourceId: doc.id,
          title: doc.title ?? `${issue.title} (${doc.key})`,
          body: doc.body,
          metadata: {
            issueId: issue.id,
            issueIdentifier: issue.identifier ?? null,
            issueTitle: issue.title,
            approvalId: input.context.approvalId ?? null,
            executionDecisionId: input.context.executionDecisionId ?? null,
            executionDecisionStageType: input.context.executionDecisionStageType ?? null,
            origin: input.context.origin,
            originRoute: input.context.originRoute ?? null,
            approvedAt: input.context.approvedAt.toISOString(),
            approvedByType: input.context.approvedBy.type,
            approvedById: input.context.approvedBy.id,
            documentId: doc.id,
            documentKey: doc.key,
            documentRevisionId: doc.latestRevisionId,
            documentRevisionNumber: doc.latestRevisionNumber,
            reviewState: "approved",
          },
        }));

      const results: Array<{ artifact: Artifact; created: boolean }> = [];
      for (const source of sources) {
        const result = await ensureApprovedArtifact(dbOrTx, {
          companyId: issue.companyId,
          source,
          approvedBy: input.context.approvedBy,
        });
        results.push(result);

        if (!result.created) continue;

        const event: ArtifactCreatedEvent = {
          artifactId: result.artifact.id,
          companyId: result.artifact.companyId,
          sourceType: result.artifact.sourceType,
          sourceId: result.artifact.sourceId,
          status: result.artifact.status,
          version: result.artifact.version,
          format: result.artifact.format,
          storageType: result.artifact.storageType,
          storagePath: result.artifact.storagePath,
          contentHash: result.artifact.contentHash,
          metadata: result.artifact.metadata,
        };

        await logActivity(db, {
          companyId: result.artifact.companyId,
          actorType: input.context.approvedBy.type,
          actorId: input.context.approvedBy.id,
          action: "artifact.created",
          entityType: "artifact",
          entityId: result.artifact.id,
          details: {
            sourceType: result.artifact.sourceType,
            sourceId: result.artifact.sourceId,
            status: result.artifact.status,
            version: result.artifact.version,
            format: result.artifact.format,
            storageType: result.artifact.storageType,
            storagePath: result.artifact.storagePath,
            contentHash: result.artifact.contentHash,
            title: result.artifact.title,
            metadata: result.artifact.metadata,
          },
        });

        await emitArtifactCreated(event);
      }

      return results;
    },
  };
}
