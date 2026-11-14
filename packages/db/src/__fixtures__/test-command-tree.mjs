import { spawn } from "node:child_process";
import fs from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

if (process.argv[2] === "root") {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild", String(process.pid)], { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
} else {
  const sql = postgres(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL, { max: 1 });
  await sql`SELECT 1`;
  fs.writeFileSync(process.env.TEST_COMMAND_TREE_READY, JSON.stringify({ root: Number(process.argv[3]), grandchild: process.pid }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await setTimeout(200);
      await sql`SELECT 1`;
      fs.writeFileSync(process.env.TEST_COMMAND_TREE_DONE, "database available during child shutdown");
      await sql.end();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void stop(); });
  setInterval(() => {}, 1000);
}
