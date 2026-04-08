import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  documentRevisions,
  teamDocuments,
  teams,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

function normalizeKey(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!key) throw unprocessable("Document key cannot be empty");
  return key;
}

const TEAM_DOCUMENT_SELECT = {
  id: teamDocuments.id,
  companyId: teamDocuments.companyId,
  teamId: teamDocuments.teamId,
  documentId: teamDocuments.documentId,
  key: teamDocuments.key,
  title: documents.title,
  format: documents.format,
  latestBody: documents.latestBody,
  latestRevisionId: documents.latestRevisionId,
  latestRevisionNumber: documents.latestRevisionNumber,
  createdByAgentId: documents.createdByAgentId,
  createdByUserId: documents.createdByUserId,
  updatedByAgentId: documents.updatedByAgentId,
  updatedByUserId: documents.updatedByUserId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

export function teamDocumentService(db: Db) {
  async function assertTeamInCompany(teamId: string, companyId: string) {
    const [row] = await db
      .select({ companyId: teams.companyId })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    if (!row) throw notFound(`Team ${teamId} not found`);
    if (row.companyId !== companyId) {
      throw Object.assign(new Error(`Team ${teamId} does not belong to this company`), {
        status: 422,
      });
    }
  }

  return {
    list: async (teamId: string, companyId: string) => {
      await assertTeamInCompany(teamId, companyId);
      return db
        .select(TEAM_DOCUMENT_SELECT)
        .from(teamDocuments)
        .innerJoin(documents, eq(teamDocuments.documentId, documents.id))
        .where(and(eq(teamDocuments.teamId, teamId), eq(teamDocuments.companyId, companyId)))
        .orderBy(asc(teamDocuments.key), desc(documents.updatedAt));
    },

    getByKey: async (teamId: string, companyId: string, rawKey: string) => {
      await assertTeamInCompany(teamId, companyId);
      const key = normalizeKey(rawKey);
      const row = await db
        .select(TEAM_DOCUMENT_SELECT)
        .from(teamDocuments)
        .innerJoin(documents, eq(teamDocuments.documentId, documents.id))
        .where(
          and(
            eq(teamDocuments.teamId, teamId),
            eq(teamDocuments.companyId, companyId),
            eq(teamDocuments.key, key),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row;
    },

    listRevisions: async (teamId: string, companyId: string, rawKey: string) => {
      await assertTeamInCompany(teamId, companyId);
      const key = normalizeKey(rawKey);
      return db
        .select({
          id: documentRevisions.id,
          documentId: documentRevisions.documentId,
          revisionNumber: documentRevisions.revisionNumber,
          title: documentRevisions.title,
          format: documentRevisions.format,
          body: documentRevisions.body,
          changeSummary: documentRevisions.changeSummary,
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByUserId: documentRevisions.createdByUserId,
          createdAt: documentRevisions.createdAt,
        })
        .from(teamDocuments)
        .innerJoin(documents, eq(teamDocuments.documentId, documents.id))
        .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
        .where(
          and(
            eq(teamDocuments.teamId, teamId),
            eq(teamDocuments.companyId, companyId),
            eq(teamDocuments.key, key),
          ),
        )
        .orderBy(desc(documentRevisions.revisionNumber));
    },

    /**
     * Create a new team document or update the existing one under the same
     * (teamId, key) with optimistic concurrency control via baseRevisionId.
     */
    upsert: async (input: {
      teamId: string;
      companyId: string;
      key: string;
      title?: string | null;
      format?: string;
      body: string;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      await assertTeamInCompany(input.teamId, input.companyId);
      const key = normalizeKey(input.key);
      const format = input.format ?? "markdown";

      return db.transaction(async (tx) => {
        const now = new Date();

        const existing = await tx
          .select({
            id: documents.id,
            latestRevisionId: documents.latestRevisionId,
            latestRevisionNumber: documents.latestRevisionNumber,
          })
          .from(teamDocuments)
          .innerJoin(documents, eq(teamDocuments.documentId, documents.id))
          .where(
            and(
              eq(teamDocuments.teamId, input.teamId),
              eq(teamDocuments.companyId, input.companyId),
              eq(teamDocuments.key, key),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existing) {
          if (!input.baseRevisionId) {
            throw conflict("Document update requires baseRevisionId", {
              currentRevisionId: existing.latestRevisionId,
            });
          }
          if (input.baseRevisionId !== existing.latestRevisionId) {
            throw conflict("Document was updated by someone else", {
              currentRevisionId: existing.latestRevisionId,
            });
          }

          const nextRevisionNumber = existing.latestRevisionNumber + 1;
          const [revision] = await tx
            .insert(documentRevisions)
            .values({
              companyId: input.companyId,
              documentId: existing.id,
              revisionNumber: nextRevisionNumber,
              title: input.title ?? null,
              format,
              body: input.body,
              changeSummary: input.changeSummary ?? null,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              createdAt: now,
            })
            .returning();

          await tx
            .update(documents)
            .set({
              title: input.title ?? null,
              format,
              latestBody: input.body,
              latestRevisionId: revision.id,
              latestRevisionNumber: nextRevisionNumber,
              updatedByAgentId: input.createdByAgentId ?? null,
              updatedByUserId: input.createdByUserId ?? null,
              updatedAt: now,
            })
            .where(eq(documents.id, existing.id));

          await tx
            .update(teamDocuments)
            .set({ updatedAt: now })
            .where(eq(teamDocuments.documentId, existing.id));

          return { created: false as const, documentId: existing.id, revisionId: revision.id };
        }

        if (input.baseRevisionId) {
          throw conflict("Document does not exist yet", { key });
        }

        // Create new document + revision + team_documents row
        const [document] = await tx
          .insert(documents)
          .values({
            companyId: input.companyId,
            title: input.title ?? null,
            format,
            latestBody: input.body,
            latestRevisionNumber: 1,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: input.companyId,
            documentId: document.id,
            revisionNumber: 1,
            title: input.title ?? null,
            format,
            body: input.body,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({ latestRevisionId: revision.id })
          .where(eq(documents.id, document.id));

        await tx.insert(teamDocuments).values({
          companyId: input.companyId,
          teamId: input.teamId,
          documentId: document.id,
          key,
        });

        return { created: true as const, documentId: document.id, revisionId: revision.id };
      });
    },

    remove: async (teamId: string, companyId: string, rawKey: string) => {
      await assertTeamInCompany(teamId, companyId);
      const key = normalizeKey(rawKey);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select({ documentId: teamDocuments.documentId })
          .from(teamDocuments)
          .where(
            and(
              eq(teamDocuments.teamId, teamId),
              eq(teamDocuments.companyId, companyId),
              eq(teamDocuments.key, key),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;
        await tx.delete(documents).where(eq(documents.id, existing.documentId));
        // team_documents row cascades
        return existing;
      });
    },
  };
}
