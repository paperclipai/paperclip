// Tenant-app stand-in for the root OS-isolation test. It runs as the app OS
// user under the real supervisor and records what that user can reach.
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const root = process.env.PROBE_MANAGED_ROOT;
const attempt = (fn) => {
  try {
    fn();
    return "allowed";
  } catch (error) {
    return error.code ?? error.message;
  }
};

async function sqlAttempt(options, statement) {
  const sql = postgres({ ...options, max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
    return "allowed";
  } catch (error) {
    return error.code ?? error.message;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

const url = new URL(process.env.DATABASE_URL);
const results = {
  uid: process.getuid(),
  gid: process.getgid(),
  groups: process.getgroups(),
  env: {
    hasConfig: "PAPERCLIP_MANAGED_DATABASE" in process.env,
    hasControlKey: "PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY" in process.env,
    hasMigrationUrl: "DATABASE_MIGRATION_URL" in process.env,
    provider: process.env.PAPERCLIP_DATABASE_PROVIDER,
    autoApply: process.env.PAPERCLIP_MIGRATION_AUTO_APPLY,
  },
  files: {
    listRoot: attempt(() => readdirSync(root)),
    listData: attempt(() => readdirSync(`${root}/data`)),
    readPgVersion: attempt(() => readFileSync(`${root}/data/PG_VERSION`)),
    readSecrets: attempt(() => readFileSync(`${root}/secrets/roles.json`)),
    readMarker: attempt(() => readFileSync(`${root}/marker.json`)),
    readVolumeIdentity: attempt(() => readFileSync(`${root}/volume.json`)),
    readLease: attempt(() => readFileSync(`${root}/state/lease.json`)),
    listReceipts: attempt(() => readdirSync(`${root}/receipts`)),
    listSnapshots: attempt(() => readdirSync(`${root}/snapshots`)),
    readReadiness: attempt(() => readFileSync(`${root}/public/readiness.json`)),
    writeReadiness: attempt(() => writeFileSync(`${root}/public/readiness.json`, "{}")),
    // If the rename succeeds (a defect), move it straight back for the later tests.
    renameManagedRoot: attempt(() => { renameSync(root, `${root}.moved`); renameSync(`${root}.moved`, root); }),
    createInVolumeRoot: attempt(() => { writeFileSync(`${path.dirname(root)}/app-file`, "x"); rmSync(`${path.dirname(root)}/app-file`); }),
    readSupervisorEnviron: attempt(() => readFileSync(`/proc/${process.ppid}/environ`)),
  },
  sql: {
    appSelect: await sqlAttempt({ host: "127.0.0.1", port: Number(url.port), user: "paperclip_app", password: decodeURIComponent(url.password), database: "paperclip" }, "select count(*) from companies"),
    appDdl: await sqlAttempt({ host: "127.0.0.1", port: Number(url.port), user: "paperclip_app", password: decodeURIComponent(url.password), database: "paperclip" }, "create table public.probe (id int)"),
    appReadServerFile: await sqlAttempt({ host: "127.0.0.1", port: Number(url.port), user: "paperclip_app", password: decodeURIComponent(url.password), database: "paperclip" }, "select pg_read_file('PG_VERSION')"),
    ownerOverSocket: await sqlAttempt({ host: `${root}/pg-socket`, port: Number(url.port), user: "paperclip_owner", password: "unknown", database: "paperclip" }, "select 1"),
    ownerOverTcp: await sqlAttempt({ host: "127.0.0.1", port: Number(url.port), user: "paperclip_owner", password: "unknown", database: "paperclip" }, "select 1"),
  },
};
writeFileSync(process.env.PROBE_RESULT_FILE, JSON.stringify(results, null, 2));
setInterval(() => {}, 60_000);
process.on("SIGTERM", () => process.exit(0));
