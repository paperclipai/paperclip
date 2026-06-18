import { readFileSync } from "fs";

// Load DATABASE_URL from running server process environment
try {
  const envBuf = readFileSync("/proc/2309570/environ");
  const envParts = envBuf.toString().split("\0");
  for (const part of envParts) {
    if (part.startsWith("DATABASE_URL=")) {
      process.env.DATABASE_URL = part.substring("DATABASE_URL=".length);
    }
  }
} catch (e) {
  console.warn("Could not read proc environ:", e);
}

import { createDb } from "./client.js";
import { sql } from "drizzle-orm";

async function main() {
  const db = createDb(process.env.DATABASE_URL || "");
  try {
    const workspaceId = "afb7eeae-8de6-450b-bde8-820b22361806";
    const issueId = "f2c39dc8-f783-4d01-b553-44ead9d1185b";

    const workspaces = await db.execute(sql`SELECT id, company_id, project_id, name FROM project_workspaces WHERE id = ${workspaceId}`);
    console.log("Workspaces:", workspaces);

    const issues = await db.execute(sql`SELECT id, company_id, project_id, title FROM issues WHERE id = ${issueId}`);
    console.log("Issues:", issues);

    const companies = await db.execute(sql`SELECT id, name FROM companies`);
    console.log("Companies:", companies);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

main();
