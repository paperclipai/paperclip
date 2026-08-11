import { and, arrayOverlaps, desc, eq, ilike, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { companyMemories } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

export interface CompanyMemoryHit {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  createdByAgentId: string | null;
  createdAt: Date;
}

// Company-scoped keyword recall over company_memories. Per-term ILIKE across
// content + title (accelerated by the pg_trgm GIN index on content), optional tag
// overlap, recency-ranked. Shared by the `recall` agent tool (minTermLength 2, an
// agent-chosen query) and run-start auto-inject (minTermLength 4 to skip stopwords
// when matching whole issue text).
export async function searchCompanyMemories(
  db: Db,
  companyId: string,
  opts: { query?: string; tags?: string[]; limit?: number; minTermLength?: number } = {},
): Promise<CompanyMemoryHit[]> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const minTermLength = opts.minTermLength ?? 2;
  const conditions: SQL[] = [eq(companyMemories.companyId, companyId)];

  const query = opts.query?.trim() ?? "";
  if (query) {
    const terms = query.split(/\s+/).filter((t) => t.length >= minTermLength).slice(0, 12);
    const needles = terms.length > 0 ? terms : [query];
    const termMatch = or(
      ...needles.flatMap((t) => [
        ilike(companyMemories.content, `%${t}%`),
        ilike(companyMemories.title, `%${t}%`),
      ]),
    );
    if (termMatch) conditions.push(termMatch);
  }

  const tags = (opts.tags ?? []).filter((t) => t.trim().length > 0);
  if (tags.length > 0) conditions.push(arrayOverlaps(companyMemories.tags, tags));

  return db
    .select({
      id: companyMemories.id,
      title: companyMemories.title,
      content: companyMemories.content,
      tags: companyMemories.tags,
      createdByAgentId: companyMemories.createdByAgentId,
      createdAt: companyMemories.createdAt,
    })
    .from(companyMemories)
    .where(and(...conditions))
    .orderBy(desc(companyMemories.createdAt))
    .limit(limit);
}
