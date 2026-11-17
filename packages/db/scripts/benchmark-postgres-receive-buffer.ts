import postgres from "postgres";
import { startEmbeddedPostgresTestDatabase } from "../src/test-embedded-postgres.js";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Run with node --expose-gc");
const connections = Number(process.env.CONNECTIONS ?? 80);
const rowBytes = Number(process.env.ROW_BYTES ?? 1_000_000);
const temporary = process.env.DATABASE_URL ? null : await startEmbeddedPostgresTestDatabase("postgres-receive-buffer-");
const sql = postgres(process.env.DATABASE_URL ?? temporary!.connectionString, {
  max: connections, idle_timeout: 60, prepare: false, onnotice: () => {},
  connection: { application_name: "receive-buffer-benchmark" },
});

function memory() {
  gc!(); gc!();
  const { heapUsed, external, rss } = process.memoryUsage();
  return { heapUsed, external, rss };
}

try {
  await sql.unsafe("select 1");
  const before = memory();
  await Promise.all(Array.from({ length: connections }, () => sql.unsafe("select pg_sleep(0.5)")));
  const open = memory();
  await Promise.all(Array.from({ length: connections }, () => sql.unsafe("select repeat('x', $1::int) as value", [rowBytes]).then(() => undefined)));
  const idleAfterLargeRow = memory();
  const perConnectionKB = (from: ReturnType<typeof memory>, to: ReturnType<typeof memory>, key: keyof ReturnType<typeof memory>) =>
    Math.round((to[key] - from[key]) / connections / 1024);
  console.log(JSON.stringify({
    connections, rowBytes,
    openIdle: { heapKB: perConnectionKB(before, open, "heapUsed"), externalKB: perConnectionKB(before, open, "external"), rssKB: perConnectionKB(before, open, "rss") },
    idleAfterLargeRow: { heapKB: perConnectionKB(before, idleAfterLargeRow, "heapUsed"), externalKB: perConnectionKB(before, idleAfterLargeRow, "external"), rssKB: perConnectionKB(before, idleAfterLargeRow, "rss") },
    pinnedExternalMB: Math.round((idleAfterLargeRow.external - open.external) / 1048576),
  }));
} finally {
  await sql.end({ timeout: 1 });
  await temporary?.cleanup();
}
