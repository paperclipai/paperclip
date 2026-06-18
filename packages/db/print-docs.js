import postgres from 'postgres';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const sql = postgres(dbUrl);
  try {
    const ids = [
      'afd7a0b7-1ddc-4727-a9a5-7fd635f9f1ca',
      'ce8f9ffe-33c7-4792-805b-bb6ba42021af',
      '193a55ce-2e60-46f7-95ac-190a04db56fd',
      'ff3ef41b-976d-4bdd-9de8-b4cabebd98f5'
    ];
    for (const id of ids) {
      const [doc] = await sql`SELECT id, title, latest_body FROM documents WHERE id = ${id}`;
      if (doc) {
        console.log("=================================================");
        console.log(`DOCUMENT ID: ${doc.id}`);
        console.log(`TITLE: ${doc.title}`);
        console.log("=================================================");
        console.log(doc.latest_body);
        console.log("\n\n");
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
