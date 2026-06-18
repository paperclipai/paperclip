import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL || "postgres://paperclip:***@localhost:5432/paperclip");

async function main() {
  try {
    const comments = await sql`
      SELECT c.id, c.issue_id, c.body, c.created_at, i.identifier, i.status
      FROM issue_comments c
      JOIN issues i ON c.issue_id = i.id
      ORDER BY c.created_at DESC
      LIMIT 10
    `;
    console.log(JSON.stringify(comments, null, 2));
  } catch (error) {
    console.error(error);
  } finally {
    await sql.end();
  }
}

main();