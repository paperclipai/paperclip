import { createDb } from "@paperclipai/db";
import { documents } from "@paperclipai/db";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("No DATABASE_URL found");
    process.exit(1);
  }
  console.log("Connecting to:", dbUrl);
  const db = createDb(dbUrl);
  const allDocs = await db.select().from(documents);
  console.log(`Found ${allDocs.length} documents.`);
  for (const doc of allDocs) {
    console.log("-----------------------------------------");
    console.log(`ID: ${doc.id}`);
    console.log(`Company ID: ${doc.companyId}`);
    console.log(`Title: ${doc.title}`);
    console.log(`Format: ${doc.format}`);
    console.log(`Length of body: ${doc.latestBody.length}`);
    console.log(`Body (first 200 chars): ${doc.latestBody.slice(0, 200)}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
