import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function main(): Promise<void> {
  const url = process.env.BRAIN_DATABASE_URL;
  if (!url) {
    throw new Error("BRAIN_DATABASE_URL must be set");
  }

  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations",
  );

  const sql = postgres(url, { max: 1, prepare: false });
  const db = drizzle(sql);

  console.log(`[brain.migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log("[brain.migrate] complete");

  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("[brain.migrate] failed:", err);
  process.exit(1);
});
