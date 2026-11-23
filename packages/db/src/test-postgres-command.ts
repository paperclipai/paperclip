import path from "node:path";
import { createDb } from "./client.js";
import { computeEmbeddedPostgresTemplateKey, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { checkTestPostgresAdmin, testPostgresAdminUrl } from "./test-postgres-admin.js";
import { beforeTestPostgresShutdown } from "./test-postgres-owner.js";
import { startTestProcessTree } from "./test-process-tree.js";

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
  const child = startTestProcessTree(command, args, env);
  const removeShutdownTask = beforeTestPostgresShutdown({
    ...child,
    afterStop: async () => { await server?.cleanup(); },
  });
  try {
    process.exitCode = await child.wait();
  } finally {
    try { await child.stop(); }
    finally { removeShutdownTask(); }
  }
} finally {
  await server?.cleanup();
}
