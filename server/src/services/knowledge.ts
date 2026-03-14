import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { knowledgeDocuments } from "@paperclipai/db";
import type { KnowledgeContextDocument } from "@paperclipai/shared";

type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;

export interface KnowledgeListFilters {
  q?: string;
}

export interface KnowledgeContextInput {
  title: string;
  description: string | null;
  project: { name: string } | null;
  goal: { title: string } | null;
  ancestors: Array<{ title: string; description: string | null }>;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizeTags(tags: string[] | null | undefined) {
  return Array.from(new Set((tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)));
}

export function trimKnowledgeContent(content: string, maxChars = 2000) {
  const normalized = content.trim();
  if (normalized.length <= maxChars) {
    return { content: normalized, truncated: false };
  }
  return {
    content: `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`,
    truncated: true,
  };
}

export function buildKnowledgeSearchTerms(input: KnowledgeContextInput) {
  const raw = [
    input.title,
    input.description ?? "",
    input.project?.name ?? "",
    input.goal?.title ?? "",
    ...input.ancestors.flatMap((ancestor) => [ancestor.title, ancestor.description ?? ""]),
  ].join(" ");

  return Array.from(new Set((raw.toLowerCase().match(/[a-z0-9][a-z0-9_\-/]{2,}/g) ?? []))).slice(0, 20);
}

function scoreKnowledgeDocument(document: KnowledgeDocumentRow, terms: string[]) {
  if (terms.length === 0) return 0;
  const title = document.title.toLowerCase();
  const category = (document.category ?? "").toLowerCase();
  const content = document.content.toLowerCase();
  const tags = normalizeTags(document.tags).join(" ");
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 6;
    if (category.includes(term)) score += 4;
    if (tags.includes(term)) score += 3;
    if (content.includes(term)) score += 1;
  }
  return score;
}

export function knowledgeService(db: Db) {
  return {
    list: async (companyId: string, filters?: KnowledgeListFilters) => {
      const conditions = [eq(knowledgeDocuments.companyId, companyId)];
      const query = filters?.q?.trim();
      if (query) {
        const pattern = `%${escapeLikePattern(query)}%`;
        conditions.push(sql<boolean>`(
          ${knowledgeDocuments.title} ILIKE ${pattern} ESCAPE '\\'
          OR COALESCE(${knowledgeDocuments.category}, '') ILIKE ${pattern} ESCAPE '\\'
          OR ${knowledgeDocuments.content} ILIKE ${pattern} ESCAPE '\\'
        )`);
      }
      return db
        .select()
        .from(knowledgeDocuments)
        .where(and(...conditions))
        .orderBy(desc(knowledgeDocuments.updatedAt));
    },

    getById: (id: string) =>
      db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof knowledgeDocuments.$inferInsert, "companyId" | "tags"> & { tags?: string[] }) =>
      db
        .insert(knowledgeDocuments)
        .values({
          ...data,
          companyId,
          tags: normalizeTags(data.tags),
        })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, companyId: string, data: Partial<Omit<typeof knowledgeDocuments.$inferInsert, "companyId" | "tags">> & { tags?: string[] }) => {
      const patch: Partial<typeof knowledgeDocuments.$inferInsert> = {
        ...data,
        updatedAt: new Date(),
      };
      if (data.tags) {
        patch.tags = normalizeTags(data.tags);
      }
      return db
        .update(knowledgeDocuments)
        .set(patch)
        .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string, companyId: string) =>
      db
        .delete(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null),

    listRelevantForIssueContext: async (companyId: string, input: KnowledgeContextInput, limit = 3) => {
      const terms = buildKnowledgeSearchTerms(input);
      if (terms.length === 0) return [] satisfies KnowledgeContextDocument[];

      const candidates = await db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.companyId, companyId))
        .orderBy(desc(knowledgeDocuments.updatedAt));

      return candidates
        .map((document) => ({ document, score: scoreKnowledgeDocument(document, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || right.document.updatedAt.getTime() - left.document.updatedAt.getTime())
        .slice(0, limit)
        .map(({ document }) => {
          const trimmed = trimKnowledgeContent(document.content);
          return {
            id: document.id,
            title: document.title,
            category: document.category,
            tags: normalizeTags(document.tags),
            content: trimmed.content,
            truncated: trimmed.truncated,
            updatedAt: document.updatedAt,
          } satisfies KnowledgeContextDocument;
        });
    },
  };
}