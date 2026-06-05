import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const MAX_PER_RUN = 10;

/**
 * idea-to-brief — act-with-approval (safe, internal). When a human approves a
 * blog idea (sets blog_ideas.status = 'approved' on the Idea inbox), this
 * advances it into the writing pipeline: it creates a content brief
 * (agnb.content_briefs, stage 'backlog') and marks the idea 'briefed', so the
 * Content Strategist / Blog Writer picks it up.
 *
 * Deliberately internal-only: it never sends email or publishes. Irreversible
 * external actions (outreach send, blog publish) stay human-triggered.
 *
 * Idempotent: only processes status='approved' ideas, then flips them to
 * 'briefed'. Hourly.
 */
export async function ideaToBrief(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const approved = rows<{ id: string; raw_text: string; related_topic: string | null }>(
    await db.execute(sql`
      SELECT id, raw_text, related_topic
      FROM agnb.blog_ideas
      WHERE status = 'approved'
      ORDER BY created_at ASC
      LIMIT ${MAX_PER_RUN}
    `),
  );

  let briefed = 0;
  for (const idea of approved) {
    if (ctx.signal.aborted) break;
    const topic = idea.related_topic?.trim();
    const title = (topic || idea.raw_text || "").slice(0, 180) || "Untitled brief";
    await db.execute(sql`
      INSERT INTO agnb.content_briefs (title, content_type, stage, primary_keyword, created_by)
      VALUES (${title}, 'blog', 'backlog', ${topic ?? null}, 'idea-to-brief')
    `);
    await db.execute(sql`UPDATE agnb.blog_ideas SET status = 'briefed' WHERE id = ${idea.id}`);
    briefed++;
  }

  ctx.log(`idea-to-brief advanced ${briefed} approved ideas to briefs`);
  return { ok: true, briefed, summary: `advanced ${briefed} approved ideas to content briefs` };
}
