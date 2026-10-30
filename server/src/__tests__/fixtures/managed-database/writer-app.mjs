// Tenant-app stand-in for managed database tests: writes rows continuously
// through the restricted DATABASE_URL the supervisor provides.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const statusFile = process.env.WRITER_STATUS_FILE;
let written = 0;
let stopping = false;

process.on("SIGTERM", async () => {
  stopping = true;
  await sql.end({ timeout: 2 }).catch(() => {});
  process.exit(0);
});

while (!stopping) {
  try {
    await sql`insert into companies (id, name, issue_prefix) values (${randomUUID()}, 'writer', ${`W${randomBytes(5).toString("hex")}`})`;
    written += 1;
    if (statusFile) writeFileSync(statusFile, JSON.stringify({ pid: process.pid, written }));
  } catch (error) {
    // Lost database: exit non-zero like the real app's fatal path would.
    process.stderr.write(`writer: ${error.message}\n`);
    process.exit(3);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
