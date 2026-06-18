import postgres from 'postgres';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("No DATABASE_URL found");
    process.exit(1);
  }
  const sql = postgres(dbUrl);
  try {
    const docs = await sql`SELECT * FROM documents`;
    console.log(`Found ${docs.length} documents.`);
    for (const doc of docs) {
      console.log("-----------------------------------------");
      console.log(`ID: ${doc.id}`);
      console.log(`Company ID: ${doc.company_id}`);
      console.log(`Title: ${doc.title}`);
      console.log(`Latest Revision Number: ${doc.latest_revision_number}`);
      console.log(`Body:\n${doc.latest_body}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
