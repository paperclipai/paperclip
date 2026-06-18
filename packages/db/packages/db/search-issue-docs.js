import postgres from 'postgres';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const sql = postgres(dbUrl);
  try {
    const rows = await sql`
      SELECT id, issue_id, document_id, is_primary
      FROM issue_documents
    `;
    console.log("Issue Documents rows:");
    for (const r of rows) {
      console.log(`- ID: ${r.id}, Issue ID: ${r.issue_id}, Document ID: ${r.document_id}, Is Primary: ${r.is_primary}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
