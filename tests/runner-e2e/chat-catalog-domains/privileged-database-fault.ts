import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getPostgresDataDirectory, closeRegisteredClients } from "../../../packages/db/src/index.js";
import { databaseCheck } from "../../../cli/src/checks/database-check.js";
import type { PaperclipConfig } from "../../../packages/shared/src/config-schema.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { prepareOwnedDockerDatabase } from "./privileged-docker-database.js";
const execute = promisify(execFile);
export function ownedPostmasterStillMatches(input: { pid: number; startedAt: string; directory: string; port: number; uid: number;
  binary: string; marker: string[]; processRow: string }) {
  const row = input.processRow.trim().match(/^(\d+)\s+([\s\S]+)$/), argv = row?.[2]?.split(/\s+/) ?? [];
  return Number(input.marker[0]) === input.pid && input.marker[1] === input.directory && input.marker[2] === input.startedAt
    && Number(input.marker[3]) === input.port && !!row && Number(row[1]) === input.uid && argv[0] === input.binary
    && argv[argv.indexOf("-D") + 1] === input.directory && argv.includes("-D");
}

/** Source-owned PG control, never an arbitrary port/PID or external database. */
export async function prepareOwnedDatabaseFault(ctx: ChatCatalogContext) {
  const temp = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT, configPath = process.env.PAPERCLIP_CONFIG;
  if (!temp || !configPath) throw new Error("Database fault requires the launcher's private owned config");
  const root = await realpath(temp), configFile = await realpath(configPath);
  if (!configFile.startsWith(root + path.sep)) throw new Error("Database fault config is outside its owned attempt");
  const config = JSON.parse(await readFile(configFile, "utf8")) as PaperclipConfig;
  if (config.database.mode === "postgres") {
    const docker = await prepareOwnedDockerDatabase(root, configFile);
    if (!ctx.input.privateSecrets) throw new Error("Owned Docker fault requires a private redaction sink");
    ctx.input.privateSecrets.push(docker.connection);
    return {
      proof: docker.proof, stop: docker.stop, recover: docker.recover,
      async doctor() {
        const result = await databaseCheck(config);
        await closeRegisteredClients(docker.connection);
        return { name: result.name, status: result.status,
          connectionFailure: result.status === "fail" && /connect|PostgreSQL/i.test(result.message), repairHint: result.repairHint ?? null };
      },
    };
  }
  if (config.database.mode !== "embedded-postgres" || !config.database.embeddedPostgresDataDir) throw new Error("Database fault is limited to the owned embedded PostgreSQL fixture");
  const directory = await realpath(config.database.embeddedPostgresDataDir);
  if (!directory.startsWith(root + path.sep) || (await stat(directory)).uid !== process.getuid?.()) throw new Error("Database directory owner differs from the current attempt owner");
  const port = config.database.embeddedPostgresPort;
  if (!Number.isSafeInteger(port) || !port || port < 1) throw new Error("Owned PostgreSQL port is invalid");
  const connection = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  if (await getPostgresDataDirectory(connection) !== directory) throw new Error("Live database directory differs from the owned config");
  ctx.input.privateSecrets?.push(connection);
  const initial = (await readFile(path.join(directory, "postmaster.pid"), "utf8")).split("\n");
  const pid = Number(initial[0]), startedAt = initial[2];
  if (!Number.isSafeInteger(pid) || pid <= 1 || await realpath(initial[1]!) !== directory || Number(initial[3]) !== port) throw new Error("Owned PostgreSQL process marker does not match directory/port");
  const raw = (await readFile(path.join(directory, "postmaster.opts"), "utf8")).trim();
  const args = raw.match(/"(?:[^"\\]|\\.)*"|[^\s]+/g)?.map(value => value.startsWith('"') ? JSON.parse(value) as string : value);
  if (!args?.length || args.some(value => !/^[A-Za-z0-9_/@.,=: +\-]+$/.test(value))) throw new Error("Owned PostgreSQL options are not safe to replay through pg_ctl");
  const binary = await realpath(args[0]!);
  if (path.basename(binary) !== "postgres") throw new Error("Owned process is not the actual PostgreSQL binary");
  const control = await realpath(path.join(path.dirname(binary), "pg_ctl"));
  if (path.dirname(control) !== path.dirname(binary)) throw new Error("PostgreSQL control binary escapes the verified package");
  const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
  async function verify() {
    const current = (await readFile(path.join(directory, "postmaster.pid"), "utf8")).split("\n");
    const processRow = (await execute("ps", ["-p", String(pid), "-o", "uid=", "-o", "command="], { timeout: 5_000 })).stdout.trim();
    if (!ownedPostmasterStillMatches({ pid, startedAt: startedAt!, directory, port, uid: process.getuid!(), binary, marker: current, processRow }))
      throw new Error("Owned PostgreSQL process changed; refusing control");
  }
  await verify();
  let stopRequested = false;
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8" };
  return {
    proof: { pid, ownerUid: process.getuid?.(), ownerMatches: true, dataDirectoryRelative: path.relative(root, directory), directoryWithinOwnedRoot: true, port, binarySha256, processStartMarker: startedAt },
    async stop() {
      await verify();
      stopRequested = true;
      try { await execute(control, ["-D", directory, "-m", "fast", "-w", "-t", "15", "stop"], { env, timeout: 20_000, maxBuffer: 65_536 }); }
      catch { throw new Error("Owned PostgreSQL stop failed; raw diagnostics withheld"); }
    },
    async doctor() {
      const result = await databaseCheck({ ...config, database: { ...config.database, mode: "postgres", connectionString: connection } });
      await closeRegisteredClients(connection);
      return { name: result.name, status: result.status, connectionFailure: result.status === "fail" && /connect|PostgreSQL/i.test(result.message),
        repairHint: result.repairHint ?? null };
    },
    async recover() {
      if (!stopRequested) return;
      // A timed-out stop may have failed before shutdown; do not start a second
      // postmaster when the exact original owned process still answers.
      const current = await getPostgresDataDirectory(connection).catch(() => null);
      if (current) { if (current !== directory) throw new Error("Owned database port now belongs to another directory"); await verify(); stopRequested = false; return; }
      const options = args.slice(1).map(value => `'${value}'`).join(" ");
      try {
        await execute(control, ["-D", directory, "-w", "-t", "30", "-l", path.join(root, "catalog-owned-pg-recovery.log"), "-o", options, "start"], { env, timeout: 35_000, maxBuffer: 65_536 });
        const actual = await getPostgresDataDirectory(connection);
        if (actual !== directory) throw new Error("Owned PostgreSQL recovered elsewhere");
        stopRequested = false;
      } catch { throw new Error("Owned PostgreSQL recovery failed; retain the owned root and private supervisor evidence"); }
    },
  };
}
