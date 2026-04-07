import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agentMemoryEntries } from "@ironworksai/db";

// ── Agent Learning System ─────────────────────────────────────────────────
//
// Retrieves lesson entries from agent memory and formats them for injection
// into agent context during heartbeat execution.

export interface AgentLesson {
  id: string;
  content: string;
  category: string | null;
  sourceIssueId: string | null;
  confidence: number;
  createdAt: Date;
}

const LESSON_CATEGORIES = [
  "lesson_learned",
  "lesson",
  "quality_flag",
  "mistake_learning",
  "feedback",
] as const;

/**
 * Retrieve lesson entries for an agent, sorted by most recent first.
 * Lessons include categories: lesson_learned, quality_flag, mistake_learning,
 * and the new "lesson" category from quality gate reflections.
 */
export async function getAgentLessons(
  db: Db,
  agentId: string,
  limit = 10,
): Promise<AgentLesson[]> {
  return db
    .select({
      id: agentMemoryEntries.id,
      content: agentMemoryEntries.content,
      category: agentMemoryEntries.category,
      sourceIssueId: agentMemoryEntries.sourceIssueId,
      confidence: agentMemoryEntries.confidence,
      createdAt: agentMemoryEntries.createdAt,
    })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.agentId, agentId),
        isNull(agentMemoryEntries.archivedAt),
        sql`${agentMemoryEntries.category} IN (${sql.join(LESSON_CATEGORIES.map((c) => sql`${c}`), sql`, `)})`,
      ),
    )
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(limit);
}

/**
 * Format lessons for prompt injection into agent context.
 * Returns a string block suitable for prepending to agent instructions.
 */
export function injectLessons(
  context: string,
  lessons: AgentLesson[],
): string {
  if (lessons.length === 0) return context;

  const lessonBlock = lessons
    .map((l, i) => `${i + 1}. [${l.category ?? "lesson"}] ${l.content}`)
    .join("\n");

  const header = `\n\n--- LESSONS FROM PAST EXPERIENCE ---\nApply these lessons to improve your work quality:\n${lessonBlock}\n--- END LESSONS ---\n\n`;

  return header + context;
}
