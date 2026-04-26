import type postgres from "postgres";
import type { ChunkWithEmbedding } from "../shared/types.js";

type Sql = ReturnType<typeof postgres>;

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export async function writeChunks(
  sql: Sql,
  noteId: string,
  chunks: Array<Omit<ChunkWithEmbedding, "noteId">>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`DELETE FROM brain.chunks WHERE note_id = $1`, [noteId]);
    for (const c of chunks) {
      await tx.unsafe(
        `INSERT INTO brain.chunks
           (note_id, chunk_index, heading_path, content, token_count, embedding, embedded_at)
         VALUES ($1, $2, $3, $4, $5, $6::vector, now())`,
        [noteId, c.chunkIndex, c.headingPath, c.content, c.tokenCount, vectorLiteral(c.embedding)],
      );
    }
  });
}

export async function countChunksForNote(sql: Sql, noteId: string): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT count(*)::text AS count FROM brain.chunks WHERE note_id = ${noteId}
  `;
  return Number(rows[0]?.count ?? 0);
}
