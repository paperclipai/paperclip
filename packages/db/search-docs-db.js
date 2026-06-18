import postgres from 'postgres';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const sql = postgres(dbUrl);
  try {
    const docs = await sql`
      SELECT id, title, left(latest_body, 100) as snippet
      FROM documents
    `;
    console.log("Documents found:");
    for (const d of docs) {
      console.log(`- ID: ${d.id}`);
      console.log(`  Title: ${d.title}`);
      console.log(`  Snippet: ${d.snippet.replace(/\n/g, ' ')}...`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
