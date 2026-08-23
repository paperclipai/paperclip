import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documentRevisions, documents, issueDocuments, issues } from "@paperclipai/db";
import { isSystemIssueDocumentKey, issueDocumentKeySchema } from "@paperclipai/shared";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";

function isConflictError(error: unknown, message: string): boolean {
  return error instanceof HttpError && error.status === 409 && error.message === message;
}

function normalizeDocumentKey(key: string) {
  const normalized = key.trim().toLowerCase();
  const parsed = issueDocumentKeySchema.safeParse(normalized);
  if (!parsed.success) {
    throw unprocessable("Invalid document key", parsed.error.issues);
  }
  return parsed.data;
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}

function nextAvailableDocumentKey(sourceKey: string, existingKeys: string[]) {
  const usedKeys = new Set(existingKeys);
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const baseMaxLength = 64 - suffix.length;
    const base = sourceKey.slice(0, baseMaxLength).replace(/[-_]+$/g, "") || "document";
    const candidate = `${base}${suffix}`;
    if (!usedKeys.has(candidate) && issueDocumentKeySchema.safeParse(candidate).success) {
      return candidate;
    }
  }
  throw conflict("Unable to choose a new document key for locked document", { key: sourceKey });
}

export function extractLegacyPlanBody(description: string | null | undefined) {
  if (!description) return null;
  const match = /<plan>\s*([\s\S]*?)\s*<\/plan>/i.exec(description);
  if (!match) return null;
  const body = match[1]?.trim();
  return body ? body : null;
}

export function mapIssueDocumentRow(
  row: {
    id: string;
    companyId: string;
    issueId: string;
    key: string;
    title: string | null;
    format: string;
    latestBody: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    updatedByAgentId: string | null;
    updatedByUserId: string | null;
    lockedAt: Date | null;
    lockedByAgentId: string | null;
    lockedByUserId: string | null;
    sourceTrust: typeof documents.$inferSelect.sourceTrust;
    createdAt: Date;
    updatedAt: Date;
  },
  includeBody: boolean,
) {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    key: row.key,
    title: row.title,
    format: row.format,
    ...(includeBody ? { body: row.latestBody } : {}),
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    lockedAt: row.lockedAt,
    lockedByAgentId: row.lockedByAgentId,
    lockedByUserId: row.lockedByUserId,
    sourceTrust: row.sourceTrust ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const issueDocumentSelect = {
  id: documents.id,
  companyId: documents.companyId,
  issueId: issueDocuments.issueId,
  key: issueDocuments.key,
  title: documents.title,
  format: documents.format,
  latestBody: documents.latestBody,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
  lockedAt: documents.lockedAt,
  lockedByAgentId: documents.lockedByAgentId,
  lockedByUserId: documents.lockedByUserId,
  sourceTrust: documents.sourceTrust,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

export function documentService(db: Db) {
  const filterSystemDocuments = <T extends { key: string }>(rows: T[], includeSystem: boolean) =>
    includeSystem ? rows : rows.filter((row) => !isSystemIssueDocumentKey(row.key));

  return {
    getIssueDocumentPayload: async (
      issue: { id: string; description: string | null },
      options: { includeSystem?: boolean } = {},
    ) => {
      const [planDocument, documentSummaries] = await Promise.all([
        db
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, "plan")))
          .then((rows) => rows[0] ?? null),
        db
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(eq(issueDocuments.issueId, issue.id))
          .orderBy(asc(issueDocuments.key), desc(documents.updatedAt)),
      ]);

      const legacyPlanBody = planDocument ? null : extractLegacyPlanBody(issue.description);

      return {
        planDocument: planDocument ? mapIssueDocumentRow(planDocument, true) : null,
        documentSummaries: filterSystemDocuments(documentSummaries, options.includeSystem ?? false)
          .map((row) => mapIssueDocumentRow(row, false)),
        legacyPlanDocument: legacyPlanBody
          ? {
              key: "plan" as const,
              body: legacyPlanBody,
              source: "issue_description" as const,
            }
          : null,
      };
    },

    listIssueDocuments: async (issueId: string, options: { includeSystem?: boolean } = {}) => {
      const rows = await db
        .select(issueDocumentSelect)
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(eq(issueDocuments.issueId, issueId))
        .orderBy(asc(issueDocuments.key), desc(documents.updatedAt));
      return filterSystemDocuments(rows, options.includeSystem ?? false).map((row) => mapIssueDocumentRow(row, true));
    },

    getIssueDocumentByKey: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      const row = await db
        .select(issueDocumentSelect)
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
        .then((rows) => rows[0] ?? null);
      return row ? mapIssueDocumentRow(row, true) : null;
    },

    listIssueDocumentRevisions: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      return db
        .select({
          id: documentRevisions.id,
          companyId: documentRevisions.companyId,
          documentId: documentRevisions.documentId,
          issueId: issueDocuments.issueId,
          key: issueDocuments.key,
          revisionNumber: documentRevisions.revisionNumber,
          title: documentRevisions.title,
          format: documentRevisions.format,
          body: documentRevisions.body,
          changeSummary: documentRevisions.changeSummary,
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByUserId: documentRevisions.createdByUserId,
          createdAt: documentRevisions.createdAt,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
        .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
        .orderBy(desc(documentRevisions.revisionNumber));
    },

    upsertIssueDocument: async (input: {
      issueId: string;
      key: string;
      title?: string | null;
      format: string;
      body: string;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      createdByRunId?: string | null;
      sourceTrust?: typeof documents.$inferInsert.sourceTrust;
      lockedDocumentStrategy?: "conflict" | "create_new_document";
    }) => {
      const key = normalizeDocumentKey(input.key);
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const maxAttempts = input.lockedDocumentStrategy === "create_new_document" ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
          const now = new Date();
          // Take an exclusive lock on the joined `documents` row before reading so
          // concurrent writers (other PUTs, revision restores, system upserts)
          // are serialized. Without this, the read→compare→write sequence
          // performs the baseRevisionId check against a stale snapshot and a
          // just-committed writer's revision looks "frozen" — a fresh GET shows
          // a new latestRevisionId while the 409 still reports the old one
          // (ETS-430/458/461). Mirrors the `for update of ${documents}`
          // pattern in document-annotations.ts and the `FOR UPDATE` usage in
          // issues.ts / companies.ts.
          await tx.execute(sql`
            select ${documents.id}
            from ${issueDocuments}
            inner join ${documents} on ${issueDocuments.documentId} = ${documents.id}
            where ${and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, key))}
            for update of ${documents}
          `);
          const existing = await tx
            .select({
              id: documents.id,
              companyId: documents.companyId,
              issueId: issueDocuments.issueId,
              key: issueDocuments.key,
              title: documents.title,
              format: documents.format,
              latestBody: documents.latestBody,
              latestRevisionId: documents.latestRevisionId,
              latestRevisionNumber: documents.latestRevisionNumber,
              createdByAgentId: documents.createdByAgentId,
              createdByUserId: documents.createdByUserId,
              updatedByAgentId: documents.updatedByAgentId,
              updatedByUserId: documents.updatedByUserId,
              lockedAt: documents.lockedAt,
              lockedByAgentId: documents.lockedByAgentId,
              lockedByUserId: documents.lockedByUserId,
              sourceTrust: documents.sourceTrust,
              createdAt: documents.createdAt,
              updatedAt: documents.updatedAt,
            })
            .from(issueDocuments)
            .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
            .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, key)))
            .then((rows) => rows[0] ?? null);

          if (existing) {
            // Reconcile the revision pointer against documentRevisions.
            // If documents.latestRevisionId is frozen (points to a stale
            // revision while documentRevisions has a newer one), use the
            // actual latest revision from the revisions table so a client
            // holding the true latest revision can proceed. The upsert below
            // atomically repairs the pointer on documents.
            let effectiveLatestRevisionId = existing.latestRevisionId;
            let effectiveLatestRevisionNumber = existing.latestRevisionNumber;
            if (existing.latestRevisionId) {
              const latestRevisionRow = (
                await tx
                  .select({
                    id: documentRevisions.id,
                    revisionNumber: documentRevisions.revisionNumber,
                  })
                  .from(documentRevisions)
                  .where(eq(documentRevisions.documentId, existing.id))
                  .orderBy(desc(documentRevisions.revisionNumber))
                  .limit(1)
              )[0] ?? null;
              if (latestRevisionRow && latestRevisionRow.id !== existing.latestRevisionId) {
                effectiveLatestRevisionId = latestRevisionRow.id;
                effectiveLatestRevisionNumber = latestRevisionRow.revisionNumber;
              }
            }

            if (existing.lockedAt) {
              if (input.lockedDocumentStrategy === "create_new_document") {
                const issueDocumentKeys = await tx
                  .select({ key: issueDocuments.key })
                  .from(issueDocuments)
                  .where(eq(issueDocuments.issueId, issue.id));
                const fallbackKey = nextAvailableDocumentKey(key, issueDocumentKeys.map((row) => row.key));

                const [document] = await tx
                  .insert(documents)
                  .values({
                    companyId: issue.companyId,
                    title: input.title ?? null,
                    format: input.format,
                    latestBody: input.body,
                    latestRevisionId: null,
                    latestRevisionNumber: 1,
                    createdByAgentId: input.createdByAgentId ?? null,
                    createdByUserId: input.createdByUserId ?? null,
                    updatedByAgentId: input.createdByAgentId ?? null,
                    updatedByUserId: input.createdByUserId ?? null,
                    lockedAt: null,
                    lockedByAgentId: null,
                    lockedByUserId: null,
                    sourceTrust: input.sourceTrust ?? null,
                    createdAt: now,
                    updatedAt: now,
                  })
                  .returning();

                const [revision] = await tx
                  .insert(documentRevisions)
                  .values({
                    companyId: issue.companyId,
                    documentId: document.id,
                    revisionNumber: 1,
                    title: input.title ?? null,
                    format: input.format,
                    body: input.body,
                    changeSummary: input.changeSummary ?? null,
                    createdByAgentId: input.createdByAgentId ?? null,
                    createdByUserId: input.createdByUserId ?? null,
                    createdByRunId: input.createdByRunId ?? null,
                    createdAt: now,
                  })
                  .returning();

                await tx
                  .update(documents)
                  .set({ latestRevisionId: revision.id })
                  .where(eq(documents.id, document.id));

                await tx.insert(issueDocuments).values({
                  companyId: issue.companyId,
                  issueId: issue.id,
                  documentId: document.id,
                  key: fallbackKey,
                  createdAt: now,
                  updatedAt: now,
                });

                return {
                  created: true as const,
                  redirectedFromLockedDocument: {
                    id: existing.id,
                    key: existing.key,
                  },
                  document: {
                    id: document.id,
                    companyId: issue.companyId,
                    issueId: issue.id,
                    key: fallbackKey,
                    title: document.title,
                    format: document.format,
                    body: document.latestBody,
                    latestRevisionId: revision.id,
                    latestRevisionNumber: 1,
                    createdByAgentId: document.createdByAgentId,
                    createdByUserId: document.createdByUserId,
                    updatedByAgentId: document.updatedByAgentId,
                    updatedByUserId: document.updatedByUserId,
                    lockedAt: null,
                    lockedByAgentId: null,
                    lockedByUserId: null,
                    sourceTrust: document.sourceTrust ?? null,
                    createdAt: document.createdAt,
                    updatedAt: document.updatedAt,
                  },
                };
              }

              throw conflict("Document is locked", {
                key: existing.key,
                documentId: existing.id,
                lockedAt: existing.lockedAt,
              });
            }

            if (!input.baseRevisionId) {
              throw conflict("Document update requires baseRevisionId", {
                currentRevisionId: effectiveLatestRevisionId,
              });
            }
            if (input.baseRevisionId !== effectiveLatestRevisionId) {
              throw conflict("Document was updated by someone else", {
                currentRevisionId: effectiveLatestRevisionId,
              });
            }

            const nextRevisionNumber = Math.max(existing.latestRevisionNumber, effectiveLatestRevisionNumber) + 1;
            const [revision] = await tx
              .insert(documentRevisions)
              .values({
                companyId: issue.companyId,
                documentId: existing.id,
                revisionNumber: nextRevisionNumber,
                title: input.title ?? null,
                format: input.format,
                body: input.body,
                changeSummary: input.changeSummary ?? null,
                createdByAgentId: input.createdByAgentId ?? null,
                createdByUserId: input.createdByUserId ?? null,
                createdByRunId: input.createdByRunId ?? null,
                createdAt: now,
              })
              .returning();

            await tx
              .update(documents)
              .set({
                title: input.title ?? null,
                format: input.format,
                latestBody: input.body,
                latestRevisionId: revision.id,
                latestRevisionNumber: nextRevisionNumber,
                updatedByAgentId: input.createdByAgentId ?? null,
                updatedByUserId: input.createdByUserId ?? null,
                sourceTrust: input.sourceTrust ?? null,
                updatedAt: now,
              })
              .where(eq(documents.id, existing.id));

            await tx
              .update(issueDocuments)
              .set({ updatedAt: now })
              .where(eq(issueDocuments.documentId, existing.id));

            return {
              created: false as const,
              document: {
                ...existing,
                title: input.title ?? null,
                format: input.format,
                body: input.body,
                latestRevisionId: revision.id,
                latestRevisionNumber: nextRevisionNumber,
                updatedByAgentId: input.createdByAgentId ?? null,
                updatedByUserId: input.createdByUserId ?? null,
                lockedAt: existing.lockedAt,
                lockedByAgentId: existing.lockedByAgentId,
                lockedByUserId: existing.lockedByUserId,
                sourceTrust: input.sourceTrust ?? null,
                updatedAt: now,
              },
            };
          }

          if (input.baseRevisionId) {
            throw conflict("Document does not exist yet", { key });
          }

          const [document] = await tx
            .insert(documents)
            .values({
              companyId: issue.companyId,
              title: input.title ?? null,
              format: input.format,
              latestBody: input.body,
              latestRevisionId: null,
              latestRevisionNumber: 1,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              updatedByAgentId: input.createdByAgentId ?? null,
              updatedByUserId: input.createdByUserId ?? null,
              lockedAt: null,
              lockedByAgentId: null,
              lockedByUserId: null,
              sourceTrust: input.sourceTrust ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

          const [revision] = await tx
            .insert(documentRevisions)
            .values({
              companyId: issue.companyId,
              documentId: document.id,
              revisionNumber: 1,
              title: input.title ?? null,
              format: input.format,
              body: input.body,
              changeSummary: input.changeSummary ?? null,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              createdByRunId: input.createdByRunId ?? null,
              createdAt: now,
            })
            .returning();

          await tx
            .update(documents)
            .set({ latestRevisionId: revision.id })
            .where(eq(documents.id, document.id));

          await tx.insert(issueDocuments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            documentId: document.id,
            key,
            createdAt: now,
            updatedAt: now,
          });

          return {
            created: true as const,
            document: {
              id: document.id,
              companyId: issue.companyId,
              issueId: issue.id,
              key,
              title: document.title,
              format: document.format,
              body: document.latestBody,
              latestRevisionId: revision.id,
              latestRevisionNumber: 1,
              createdByAgentId: document.createdByAgentId,
              createdByUserId: document.createdByUserId,
              updatedByAgentId: document.updatedByAgentId,
              updatedByUserId: document.updatedByUserId,
              lockedAt: document.lockedAt,
              lockedByAgentId: document.lockedByAgentId,
              lockedByUserId: document.lockedByUserId,
              sourceTrust: document.sourceTrust ?? null,
              createdAt: document.createdAt,
              updatedAt: document.updatedAt,
            },
          };
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            if (input.lockedDocumentStrategy === "create_new_document" && attempt < maxAttempts - 1) {
              continue;
            }
            throw conflict("Document key already exists on this issue", { key });
          }
          throw error;
        }
      }

      throw conflict("Unable to choose a new document key for locked document", { key });
    },

    restoreIssueDocumentRevision: async (input: {
      issueId: string;
      key: string;
      revisionId: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const key = normalizeDocumentKey(input.key);
      return db.transaction(async (tx) => {
        // Take an exclusive lock on the joined `documents` row before reading so
        // concurrent writers (other PUTs, revision restores, system upserts)
        // are serialized. Without this, a restore racing an upsert on the same
        // document computes nextRevisionNumber from a stale pointer and can
        // reintroduce the frozen documentRevisions/pointer desync that
        // ETS-430/458/461 fixed. Mirrors the `for update of ${documents}`
        // pattern in upsertIssueDocument above (documents.ts:237).
        await tx.execute(sql`
          select ${documents.id}
          from ${issueDocuments}
          inner join ${documents} on ${issueDocuments.documentId} = ${documents.id}
          where ${and(eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, key))}
          for update of ${documents}
        `);

        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");

        // Reconcile the revision pointer against documentRevisions so the next
        // revision inserted below is strictly greater than any revision that
        // just landed concurrently on this document. Also reconciles the id so
        // the "already the latest revision" check below doesn't 409 against
        // the stale pointer. Mirrors the effectiveLatestRevisionId/Number
        // reconciliation in upsertIssueDocument above (documents.ts:278-296).
        let effectiveLatestRevisionId = existing.latestRevisionId;
        let effectiveLatestRevisionNumber = existing.latestRevisionNumber;
        if (existing.latestRevisionId) {
          const latestRevisionRow = (
            await tx
              .select({
                id: documentRevisions.id,
                revisionNumber: documentRevisions.revisionNumber,
              })
              .from(documentRevisions)
              .where(eq(documentRevisions.documentId, existing.id))
              .orderBy(desc(documentRevisions.revisionNumber))
              .limit(1)
          )[0] ?? null;
          if (latestRevisionRow && (latestRevisionRow.id !== effectiveLatestRevisionId || latestRevisionRow.revisionNumber > effectiveLatestRevisionNumber)) {
            effectiveLatestRevisionId = latestRevisionRow.id;
            effectiveLatestRevisionNumber = latestRevisionRow.revisionNumber;
          }
        }

        if (existing.lockedAt) {
          throw conflict("Document is locked", {
            key: existing.key,
            documentId: existing.id,
            lockedAt: existing.lockedAt,
          });
        }

        const revision = await tx
          .select({
            id: documentRevisions.id,
            companyId: documentRevisions.companyId,
            documentId: documentRevisions.documentId,
            revisionNumber: documentRevisions.revisionNumber,
            title: documentRevisions.title,
            format: documentRevisions.format,
            body: documentRevisions.body,
          })
          .from(documentRevisions)
          .where(and(eq(documentRevisions.id, input.revisionId), eq(documentRevisions.documentId, existing.id)))
          .then((rows) => rows[0] ?? null);

        if (!revision) throw notFound("Document revision not found");
        if (effectiveLatestRevisionId === revision.id) {
          throw conflict("Selected revision is already the latest revision", {
            currentRevisionId: effectiveLatestRevisionId,
          });
        }

        const now = new Date();
        const nextRevisionNumber = effectiveLatestRevisionNumber + 1;
        const [restoredRevision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: existing.companyId,
            documentId: existing.id,
            revisionNumber: nextRevisionNumber,
            title: revision.title ?? null,
            format: revision.format,
            body: revision.body,
            changeSummary: `Restored from revision ${revision.revisionNumber}`,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({
            title: revision.title ?? null,
            format: revision.format,
            latestBody: revision.body,
            latestRevisionId: restoredRevision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(issueDocuments)
          .set({ updatedAt: now })
          .where(eq(issueDocuments.documentId, existing.id));

        return {
          restoredFromRevisionId: revision.id,
          restoredFromRevisionNumber: revision.revisionNumber,
          document: {
            ...existing,
            title: revision.title ?? null,
            format: revision.format,
            body: revision.body,
            latestRevisionId: restoredRevision.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            updatedAt: now,
          },
        };
      });
    },

    lockIssueDocument: async (input: {
      issueId: string;
      key: string;
      lockedByAgentId?: string | null;
      lockedByUserId?: string | null;
    }) => {
      const key = normalizeDocumentKey(input.key);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (existing.lockedAt) {
          return {
            changed: false as const,
            document: mapIssueDocumentRow(existing, true),
          };
        }

        const now = new Date();
        await tx
          .update(documents)
          .set({
            lockedAt: now,
            lockedByAgentId: input.lockedByAgentId ?? null,
            lockedByUserId: input.lockedByUserId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(issueDocuments)
          .set({ updatedAt: now })
          .where(eq(issueDocuments.documentId, existing.id));

        return {
          changed: true as const,
          document: {
            ...mapIssueDocumentRow(existing, true),
            lockedAt: now,
            lockedByAgentId: input.lockedByAgentId ?? null,
            lockedByUserId: input.lockedByUserId ?? null,
            updatedAt: now,
          },
        };
      });
    },

    unlockIssueDocument: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) throw notFound("Document not found");
        if (!existing.lockedAt) {
          return {
            changed: false as const,
            document: mapIssueDocumentRow(existing, true),
          };
        }

        const now = new Date();
        await tx
          .update(documents)
          .set({
            lockedAt: null,
            lockedByAgentId: null,
            lockedByUserId: null,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        await tx
          .update(issueDocuments)
          .set({ updatedAt: now })
          .where(eq(issueDocuments.documentId, existing.id));

        return {
          changed: true as const,
          document: {
            ...mapIssueDocumentRow(existing, true),
            lockedAt: null,
            lockedByAgentId: null,
            lockedByUserId: null,
            updatedAt: now,
          },
        };
      });
    },

    deleteIssueDocument: async (issueId: string, rawKey: string) => {
      const key = normalizeDocumentKey(rawKey);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
          .then((rows) => rows[0] ?? null);

        if (!existing) return null;
        if (existing.lockedAt) {
          throw conflict("Document is locked", {
            key: existing.key,
            documentId: existing.id,
            lockedAt: existing.lockedAt,
          });
        }

        await tx.delete(issueDocuments).where(eq(issueDocuments.documentId, existing.id));
        await tx.delete(documents).where(eq(documents.id, existing.id));

        return {
          ...existing,
          body: existing.latestBody,
          latestRevisionId: existing.latestRevisionId ?? null,
        };
      });
    },
  };
}
