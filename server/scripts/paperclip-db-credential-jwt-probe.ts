// One-shot operator-side smoke. Never prints the DB URL or issued JWT.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  runAdapterExecutionTargetProcess,
  type AdapterSandboxExecutionTarget,
} from "../../packages/adapter-utils/src/execution-target.js";
import { runChildProcess } from "../../packages/adapter-utils/src/server-utils.js";
import {
  agents,
  closeRegisteredClients,
  companies,
  createDb,
  heartbeatRuns,
  resolveDatabaseConnectionString,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../src/agent-auth-jwt.js";

const apiUrl = process.argv[2];
const agentFixtureDir = process.argv[3];
const repoRoot = process.argv[4];
if (!apiUrl || !/^http:\/\/(?:127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3}):\d+$/.test(apiUrl) || !agentFixtureDir || !repoRoot) {
  throw new Error("Expected a synthetic API URL, agent fixture directory and repository root");
}
const dbUrl = resolveDatabaseConnectionString({});
if (!dbUrl || !process.env.PAPERCLIP_DATABASE_URL_FILE || process.env.DATABASE_URL) {
  throw new Error("Expected a file-backed DB source without DATABASE_URL");
}

const db = createDb(dbUrl);
try {
  const backupDir = join(agentFixtureDir, "private-backup");
  mkdirSync(backupDir, { mode: 0o700 });
  const backup = await runDatabaseBackup({
    connectionString: dbUrl,
    backupDir,
    retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
    filenamePrefix: "synthetic",
    backupEngine: "pg_dump",
  });
  const restoreUrl = new URL(dbUrl);
  restoreUrl.pathname = "/paperclip_restore";
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), "paperclip_restore");
  await runDatabaseRestore({ connectionString: restoreUrl.toString(), backupFile: backup.backupFile });
  console.log("File-backed pg_dump and psql restore passed without a URL in argv");

  const [company] = await db.insert(companies).values({
    name: "Synthetic DB credential JWT smoke",
    issuePrefix: `SJ${randomUUID().replace(/-/g, "").slice(0, 8)}`,
  }).returning({ id: companies.id });
  if (!company) throw new Error("Company seed failed");
  const [agent] = await db.insert(agents).values({
    companyId: company.id,
    name: "Synthetic JWT agent",
    role: "general",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
  }).returning({ id: agents.id });
  if (!agent) throw new Error("Agent seed failed");
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId: company.id,
    agentId: agent.id,
    status: "running",
  });
  const jwt = createLocalAgentJwt(agent.id, company.id, "codex_local", runId);
  if (!jwt) throw new Error("Run-scoped JWT issuance failed");

  // Docker UID and remote sandbox transport both launch a real process under
  // a distinct UID. -e NAME forwards only values supplied by the launcher.
  const forwardedEnv = {
    PAPERCLIP_API_URL: apiUrl,
    PAPERCLIP_API_KEY: jwt,
    PAPERCLIP_RUN_ID: runId,
    EXPECTED_AGENT_ID: agent.id,
    EXPECTED_SERVICE_UID: String(process.getuid?.() ?? -1),
    KNOWN_CREDENTIAL_PATH: "/probe/database-url",
  };
  const dockerPrefix = [
    "run", "--rm", "--network", process.env.PAPERCLIP_E2E_DOCKER_NETWORK ?? "none", "--user", "65534:65534",
    "--mount", `type=bind,src=${join(agentFixtureDir, "agent-probe.py")},dst=/probe/agent-probe.py,readonly`,
    "--env", "PAPERCLIP_API_URL",
    "--env", "PAPERCLIP_API_KEY",
    "--env", "PAPERCLIP_RUN_ID",
    "--env", "EXPECTED_AGENT_ID",
    "--env", "EXPECTED_SERVICE_UID",
    "--env", "KNOWN_CREDENTIAL_PATH",
    "--env", "DATABASE_URL",
    "--env", "DATABASE_MIGRATION_URL",
    "--env", "PAPERCLIP_DATABASE_URL_FILE",
    "--env", "PAPERCLIP_AGENT_JWT_SECRET",
    "--env", "PGDATABASE",
    "paperclip-db-credential-e2e:local",
  ];
  const launchInDocker = async (processRunId: string, command: string, args: string[], env: Record<string, string>) =>
    runChildProcess(processRunId, "docker", [
      ...dockerPrefix, command, ...args,
    ], {
      cwd: agentFixtureDir,
      env,
      timeoutSec: 20,
      graceSec: 2,
      onLog: async () => {},
    });
  const sandboxTarget: AdapterSandboxExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    remoteCwd: "/probe",
    runner: {
      execute: async (input) => {
        if (input.cwd !== "/probe") throw new Error("Unexpected sandbox cwd");
        return launchInDocker(`${runId}-sandbox-container`, input.command, input.args ?? [], input.env ?? {});
      },
    },
  };
  for (const [label, target] of [
    ["docker-uid", { kind: "local" }],
    ["sandbox", sandboxTarget],
  ] as const) {
    const result = label === "docker-uid"
      ? await launchInDocker(`${runId}-docker-uid`, "python3", ["/probe/agent-probe.py"], forwardedEnv)
      : await runAdapterExecutionTargetProcess(runId, target, "python3", ["/probe/agent-probe.py"], {
        cwd: agentFixtureDir,
        env: forwardedEnv,
        timeoutSec: 20,
        graceSec: 2,
        onLog: async () => {},
      });
    if (result.exitCode !== 0 || !result.stdout.includes("Launched agent: credential read denied; DB/signing env keys 0; JWT API HTTP 200")) {
      const diagnostic = result.stderr.split("\n")
        .filter((line) => /^(?:docker:|Error response|.*(?:RuntimeError|HTTPError|PermissionError|ModuleNotFoundError):)/.test(line))
        .map((line) => line.replaceAll(dbUrl, "[redacted database URL]")
          .replaceAll(new URL(dbUrl).password, "[redacted password]").replaceAll(jwt, "[redacted API token]"))
        .slice(-2).join("; ");
      throw new Error(`${label} agent credential and JWT check failed (exit ${result.exitCode ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    console.log(`${label} launcher: credential read denied; DB/signing env keys 0; JWT API HTTP 200`);
  }
  const localEnv = {
    ...forwardedEnv,
    PAPERCLIP_COMPANY_ID: company.id,
    PAPERCLIP_DATABASE_URL_FILE: "/run/credentials/paperclip/database-url",
    PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "",
    KNOWN_CREDENTIAL_PATH: "/run/credentials/paperclip/database-url",
    WORKSPACE_DIR: join(agentFixtureDir, "workspace"),
  };
  if (!localEnv.PAPERCLIP_AGENT_JWT_SECRET) throw new Error("Synthetic JWT signing source missing");
  const localResult = await runChildProcess(`${runId}-local-bwrap-container`, "docker", [
    "run", "--rm", "--network", process.env.PAPERCLIP_E2E_DOCKER_NETWORK ?? "none",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--cap-drop", "ALL", "--cap-add", "SYS_ADMIN",
    "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
    "--mount", `type=bind,src=${repoRoot},dst=${repoRoot},readonly`,
    "--mount", `type=bind,src=${join(agentFixtureDir, "workspace")},dst=${join(agentFixtureDir, "workspace")}`,
    "--workdir", repoRoot,
    ...Object.keys(localEnv).flatMap((key) => ["--env", key]),
    "paperclip-db-credential-local-sandbox-e2e:local",
    join(repoRoot, "server/node_modules/.bin/tsx"),
    join(repoRoot, "server/scripts/paperclip-db-credential-local-sandbox-probe.ts"),
  ], {
    cwd: repoRoot,
    env: localEnv,
    timeoutSec: 60,
    graceSec: 3,
    onLog: async () => {},
  });
  if (localResult.exitCode !== 0 ||
      !localResult.stdout.includes("substituted Bubblewrap: denied before launcher execution") ||
      !localResult.stdout.includes("workspace sandbox: trusted Bubblewrap despite agent PATH; loader override stripped; credential path hidden; DB/signing env keys 0; JWT API HTTP 200") ||
      !localResult.stdout.includes("codex-home remote staging: planted service link denied; partial asset 0; credential bytes/log 0; JWT API HTTP 200") ||
      !localResult.stdout.includes("codex-home directory alias: same-UID 0700 parent denied; partial asset 0; credential bytes/log 0; JWT API HTTP 200") ||
      !localResult.stdout.includes("codex-home positive staging: bound auth and selected skill copied; JWT API HTTP 200") ||
      !localResult.stdout.includes("alias race: pinned directory visible; credential read denied")) {
    const diagnostic = localResult.stderr.replaceAll(dbUrl, "[redacted database URL]")
      .replaceAll(new URL(dbUrl).password, "[redacted password]")
      .replaceAll(jwt, "[redacted API token]")
      .split("\n").filter(Boolean).slice(-8).join("; ");
    const passed = localResult.stdout.split("\n").filter((line) =>
      /^(?:unconfined local|local network-only|unconfined ACPX|explicit DB source|credential-bearing mount|substituted Bubblewrap|workspace sandbox|codex-home remote staging|codex-home directory alias|codex-home positive staging|alias race):/.test(line)).length;
    throw new Error(`workspace sandbox container check failed (exit ${localResult.exitCode ?? "unknown"}; passed ${passed}/11)${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  for (const line of localResult.stdout.split("\n")) {
    if (/^(?:unconfined local|local network-only|unconfined ACPX|explicit DB source|credential-bearing mount|substituted Bubblewrap|workspace sandbox|codex-home remote staging|codex-home directory alias|codex-home positive staging|alias race):/.test(line)) {
      console.log(line);
    }
  }
  console.log("Run-scoped JWT issuance with file-backed DB source passed");
} finally {
  await closeRegisteredClients(dbUrl);
}
