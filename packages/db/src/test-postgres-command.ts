import { spawn } from "node:child_process";
import path from "node:path";
import { constants } from "node:os";
import { createDb } from "./client.js";
import { computeEmbeddedPostgresTemplateKey, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { checkTestPostgresAdmin, testPostgresAdminUrl } from "./test-postgres-admin.js";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const command = args.shift() ?? process.execPath;
if (command === process.execPath && args.length === 0) args.push(path.resolve("scripts/run-vitest-stable.mjs"));

let server: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
try {
  const env = { ...process.env };
  let adminUrl = testPostgresAdminUrl();
  if (adminUrl) await checkTestPostgresAdmin(adminUrl);
  else {
    server = await startEmbeddedPostgresTestDatabase("paperclip-test-command-");
    const url = new URL(server.connectionString);
    url.pathname = "/postgres";
    adminUrl = url.toString();
    if (env.PAPERCLIP_TEST_POSTGRES_TEMPLATE !== "0") {
      const template = `paperclip_test_template_${computeEmbeddedPostgresTemplateKey()}`;
      const admin = createDb(adminUrl, { maxConnections: 1 });
      try { await admin.$client.unsafe(`CREATE DATABASE "${template}" TEMPLATE "paperclip"`); }
      finally { await admin.$client.end({ timeout: 1 }); }
      env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = template;
    }
  }
  env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL = adminUrl;
  console.log("[test:postgres] Each suite gets a disposable database on one test PostgreSQL server");
  const child = spawn(command, args, { stdio: "inherit", env });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  await server?.cleanup();
}
