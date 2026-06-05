import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const MAX_PER_RUN = 5;

/**
 * cross-channel-repurpose — one insight, every channel. Topics that became blog
 * ideas from content gaps (via gap-to-idea) are also seeded as a YouTube idea
 * and a LinkedIn hook, so the YouTube + LinkedIn producer agents pick them up.
 * Turns a single piece of competitor research into multi-channel output.
 *
 * Idempotent: dedupe per topic+channel (notes/angle = 'content-gap'). Daily.
 */
export async function crossChannelRepurpose(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const topics = rows<{ topic: string }>(
    await db.execute(sql`
      SELECT DISTINCT related_topic AS topic
      FROM agnb.blog_ideas b
      WHERE b.source = 'content-gap' AND b.related_topic IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agnb.youtube_ideas y WHERE y.source = 'content-gap' AND y.notes = b.related_topic
        )
      ORDER BY related_topic
      LIMIT ${MAX_PER_RUN}
    `),
  );

  let youtube = 0;
  let linkedin = 0;
  for (const t of topics) {
    if (ctx.signal.aborted) break;
    const topic = t.topic;

    await db.execute(sql`
      INSERT INTO agnb.youtube_ideas (id, title, source, status, notes)
      SELECT gen_random_uuid(), ${`How ${topic} actually works (and why it matters)`}, 'content-gap', 'inbox', ${topic}
      WHERE NOT EXISTS (SELECT 1 FROM agnb.youtube_ideas WHERE source = 'content-gap' AND notes = ${topic})
    `);
    youtube++;

    await db.execute(sql`
      INSERT INTO agnb.linkedin_hooks (hook, angle, notes)
      SELECT ${`Most teams get "${topic}" wrong. Here's the 2-minute version.`}, 'content-gap', ${topic}
      WHERE NOT EXISTS (SELECT 1 FROM agnb.linkedin_hooks WHERE angle = 'content-gap' AND notes = ${topic})
    `);
    linkedin++;
  }

  ctx.log(`cross-channel-repurpose: ${youtube} youtube ideas, ${linkedin} linkedin hooks`);
  return { ok: true, youtube, linkedin, summary: `repurposed ${topics.length} topics to YouTube + LinkedIn` };
}
