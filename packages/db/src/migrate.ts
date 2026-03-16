import { applyPendingMigrations, inspectMigrations } from "./client.js";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL is required for db:migrate");
}

const before = await inspectMigrations(url);
if (before.status === "upToDate") {
  console.log("No pending migrations");
} else {
  console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
  await applyPendingMigrations(url);

  const after = await inspectMigrations(url);
  if (after.status !== "upToDate") {
    throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
  }
  console.log("Migrations complete");
}
