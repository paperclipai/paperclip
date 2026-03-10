import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { knowledgeEntries, records } from "@paperclipai/db";
import type { AnyRecord, KnowledgeEntry } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { recordService } from "./records.js";

function toKnowledgeEntry(row: typeof knowledgeEntries.$inferSelect): KnowledgeEntry {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
  const attachments = Array.isArray(metadata?.attachments) ? (metadata?.attachments as KnowledgeEntry["attachments"]) : [];
  const links = Array.isArray(metadata?.links) ? (metadata?.links as KnowledgeEntry["links"]) : [];
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    summary: row.summary ?? null,
    bodyMd: row.bodyMd ?? null,
    sourceRecordId: row.sourceRecordId ?? null,
    kind: row.kind,
    scopeType: row.scopeType as KnowledgeEntry["scopeType"],
    scopeRefId: row.scopeRefId,
    status: row.status as KnowledgeEntry["status"],
    publishedAt: row.publishedAt ?? null,
    metadata,
    attachments,
    links,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function shouldAutoPublishToKnowledge(record: AnyRecord) {
  if (record.metadata && typeof record.metadata === "object" && record.metadata["knowledgeAutoPublish"] === false) {
    return false;
  }
  if (record.metadata && typeof record.metadata === "object" && record.metadata["knowledgeAutoPublish"] === true) {
    return true;
  }
  if (record.category === "result") {
    return ["deliverable", "finding", "decision_outcome", "status_report"].includes(record.kind);
  }
  if (record.category === "briefing") {
    return ["executive_rollup", "project_status_report", "board_packet", "incident_summary"].includes(record.kind);
  }
  return false;
}

export function knowledgeService(db: Db) {
  const recordsSvc = recordService(db);

  async function publishRecord(recordId: string, opts?: { requireEligible?: boolean }) {
    const record = await recordsSvc.getById(recordId);
    if (!record) throw notFound("Record not found");
    if (record.category === "plan") {
      throw unprocessable("Plans cannot be published to knowledge");
    }
    if (record.status !== "published") {
      throw conflict("Only published results and briefings can be published to knowledge");
    }
    if (opts?.requireEligible && !shouldAutoPublishToKnowledge(record)) {
      throw unprocessable("This record kind is not configured for automatic knowledge publication");
    }

    const now = new Date();
    const metadata: Record<string, unknown> = {
      ...(record.metadata ?? {}),
      attachments: record.attachments ?? [],
      links: record.links ?? [],
    };
    const existing = await db
      .select()
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.companyId, record.companyId), eq(knowledgeEntries.sourceRecordId, record.id)))
      .then((rows) => rows[0] ?? null);

    if (existing) {
      const [updated] = await db
        .update(knowledgeEntries)
        .set({
          title: record.title,
          summary: record.summary,
          bodyMd: record.bodyMd,
          kind: record.kind,
          scopeType: record.scopeType,
          scopeRefId: record.scopeRefId,
          status: "published",
          publishedAt: record.publishedAt ?? now,
          metadata,
          updatedAt: now,
        })
        .where(eq(knowledgeEntries.id, existing.id))
        .returning();
      return toKnowledgeEntry(updated);
    }

    const [created] = await db
      .insert(knowledgeEntries)
      .values({
        companyId: record.companyId,
        title: record.title,
        summary: record.summary,
        bodyMd: record.bodyMd,
        sourceRecordId: record.id,
        kind: record.kind,
        scopeType: record.scopeType,
        scopeRefId: record.scopeRefId,
        status: "published",
        publishedAt: record.publishedAt ?? now,
        metadata,
      })
      .returning();
    return toKnowledgeEntry(created);
  }

  return {
    list: async (companyId: string) => {
      const rows = await db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.companyId, companyId))
        .orderBy(desc(knowledgeEntries.publishedAt), desc(knowledgeEntries.updatedAt), desc(knowledgeEntries.createdAt));
      return rows.map(toKnowledgeEntry);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toKnowledgeEntry(row) : null;
    },

    publishRecord,

    autoPublishEligibleRecord: async (recordId: string) => {
      const record = await recordsSvc.getById(recordId);
      if (!record || !shouldAutoPublishToKnowledge(record)) return null;
      if (record.status !== "published") return null;
      return publishRecord(recordId, { requireEligible: false });
    },
  };
}
