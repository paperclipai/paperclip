import postgres from 'postgres';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const sql = postgres(dbUrl);
  try {
    const unlinked = await sql`
      SELECT d.id, d.title
      FROM documents d
      LEFT JOIN issue_documents id ON d.id = id.document_id
      WHERE id.document_id IS NULL
    `;
    console.log("Unlinked Documents:");
    for (const d of unlinked) {
      console.log(`- ID: ${d.id}, Title: ${d.title}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
