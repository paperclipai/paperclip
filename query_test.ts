import { createDb } from "./packages/db/src/client.js";
import { sql } from "drizzle-orm";

async function main() {
  const db = await createDb();
  try {
    const workspaceId = "afb7eeae-8de6-450b-bde8-820b22361806";
    const issueId = "f2c39dc8-f783-4d01-b553-44ead9d1185b";

    const workspaces = await db.execute(sql`SELECT id, company_id, project_id, name FROM project_workspaces WHERE id = ${workspaceId}`);
    console.log("Workspaces:", workspaces.rows);

    const issues = await db.execute(sql`SELECT id, company_id, project_id, title FROM issues WHERE id = ${issueId}`);
    console.log("Issues:", issues.rows);

    const companies = await db.execute(sql`SELECT id, name FROM companies`);
    console.log("Companies:", companies.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

main();
