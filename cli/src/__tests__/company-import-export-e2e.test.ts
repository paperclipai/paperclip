import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createStoredZipArchive } from "./helpers/zip.js";
import { readRuntimeInfo } from "../runtime-info.js";

const execFileAsync = promisify(execFile);
type ServerProcess = ReturnType<typeof spawn>;

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company import/export e2e tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function writeTestConfig(configPath: string, tempRoot: string, port: number, connectionString: string) {
  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "doctor",
    },
    database: {
      mode: "postgres",
      connectionString,
      embeddedPostgresDataDir: path.join(tempRoot, "embedded-db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(tempRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(tempRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port,
      allowedHostnames: [],
      serveUi: false,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(tempRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(tempRoot, "secrets", "master.key"),
      },
    },
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

interface TestPaperclipEnv {
  configPath: string;
  paperclipHome: string;
  instanceId: string;
  shellHome?: string;
}

function createBasePaperclipEnv(options: TestPaperclipEnv) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }

  env.PAPERCLIP_CONFIG = options.configPath;
  env.PAPERCLIP_HOME = options.paperclipHome;
  env.PAPERCLIP_INSTANCE_ID = options.instanceId;
  env.PAPERCLIP_CONTEXT = path.join(options.paperclipHome, "context.json");
  env.PAPERCLIP_AUTH_STORE = path.join(options.paperclipHome, "auth.json");
  if (options.shellHome) {
    env.HOME = options.shellHome;
  }

  return env;
}

function createServerEnv(
  configPath: string,
  port: number,
  connectionString: string,
  options: Omit<TestPaperclipEnv, "configPath">,
) {
  const env = createBasePaperclipEnv({
    configPath,
    ...options,
  });

  delete env.DATABASE_URL;
  delete env.PORT;
  delete env.HOST;
  delete env.SERVE_UI;
  delete env.HEARTBEAT_SCHEDULER_ENABLED;

  env.DATABASE_URL = connectionString;
  env.HOST = "127.0.0.1";
  env.PORT = String(port);
  env.SERVE_UI = "false";
  env.PAPERCLIP_DB_BACKUP_ENABLED = "false";
  env.PAPERCLIP_DECISION_SIGNING_SECRET = "company-import-export-decision-signing-secret";
  env.HEARTBEAT_SCHEDULER_ENABLED = "false";
  env.PAPERCLIP_MIGRATION_AUTO_APPLY = "true";
  env.PAPERCLIP_UI_DEV_MIDDLEWARE = "false";
  // This fixture verifies control-plane persistence without provider execution.
  // Its isolated HOME prevents reuse of developer login files; remove API
  // credentials and alternative credential homes as well.
  for (const key of [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
    "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "XAI_API_KEY", "GROK_API_KEY",
    "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME",
  ]) delete env[key];

  return env;
}

function createCliEnv(options: TestPaperclipEnv) {
  const env = createBasePaperclipEnv(options);
  delete env.DATABASE_URL;
  delete env.PORT;
  delete env.HOST;
  delete env.SERVE_UI;
  delete env.PAPERCLIP_DB_BACKUP_ENABLED;
  delete env.HEARTBEAT_SCHEDULER_ENABLED;
  delete env.PAPERCLIP_MIGRATION_AUTO_APPLY;
  delete env.PAPERCLIP_UI_DEV_MIDDLEWARE;
  return env;
}

function collectTextFiles(root: string, current: string, files: Record<string, string>) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectTextFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    files[relativePath] = readFileSync(absolutePath, "utf8");
  }
}

async function stopServerProcess(child: ServerProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(forceKill);
      clearTimeout(deadline);
      child.removeListener("exit", exited);
      child.removeListener("error", failed);
    };
    const exited = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    // The child is the actual CLI/server process, so both signals target only
    // the owned fixture PID, without relying on wrapper signal forwarding.
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`The fixture server PID ${child.pid} did not exit after SIGKILL`));
    }, 6_000);
    child.once("exit", exited);
    child.once("error", failed);
    child.kill("SIGTERM");
  });
}

async function api<T>(baseUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${pathname}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} ${pathname}: ${text}`);
  }
  return text ? JSON.parse(text) as T : (null as T);
}

function isPortableAgent(agent: { metadata?: Record<string, unknown> | null }) {
  const marker = agent.metadata?.paperclipBuiltInAgent;
  return typeof marker !== "object" || marker === null;
}

async function runCliJson<T>(
  args: string[],
  opts: TestPaperclipEnv & { apiBase?: string; includeConfigArg?: boolean },
) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const cliArgs = ["--silent", "paperclipai", ...args];
  if (opts.apiBase) {
    cliArgs.push("--api-base", opts.apiBase);
  }
  if (opts.includeConfigArg !== false) {
    cliArgs.push("--config", opts.configPath);
  }
  cliArgs.push("--json");
  const result = await execFileAsync(
    "pnpm",
    cliArgs,
    {
      cwd: repoRoot,
      env: createCliEnv(opts),
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const stdout = result.stdout.trim();
  const jsonStart = stdout.search(/[\[{]/);
  if (jsonStart === -1) {
    throw new Error(`CLI did not emit JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(stdout.slice(jsonStart)) as T;
}

async function waitForServer(
  apiBase: string,
  child: ServerProcess,
  output: { stdout: string[]; stderr: string[] },
  runtimeInfoPath: string,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `paperclipai run exited before healthcheck succeeded.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
      );
    }

    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok && readRuntimeInfo(undefined, runtimeInfoPath)?.pid === child.pid) return;
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for ${apiBase}/api/health.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
  );
}

async function waitForServerPortClosed(apiBase: string) {
  const { hostname, port } = new URL(apiBase);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: hostname, port: Number(port) });
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(true); });
    });
    if (!listening) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The stopped fixture server still listens on ${apiBase}`);
}

describeEmbeddedPostgres("paperclipai company import/export e2e", () => {
  let tempRoot = "";
  let configPath = "";
  let exportDir = "";
  let apiBase = "";
  let paperclipHome = "";
  let cliShellHome = "";
  let paperclipInstanceId = "";
  let serverPort = 0;
  let serverProcess: ServerProcess | null = null;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  async function startServer() {
    if (!tempDb) throw new Error("The fixture database is not initialized");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const output = { stdout: [] as string[], stderr: [] as string[] };
    // Match the production CLI entrypoint without pnpm/tsx CLI wrappers: the
    // spawned PID owns the HTTP listener and receives the shutdown signal.
    const child = spawn(process.execPath, [
      "--import", path.join(repoRoot, "cli/node_modules/tsx/dist/loader.mjs"),
      path.join(repoRoot, "cli/src/index.ts"), "run", "--config", configPath,
    ], {
      cwd: repoRoot,
      env: createServerEnv(configPath, serverPort, tempDb.connectionString, {
        paperclipHome,
        instanceId: paperclipInstanceId,
        shellHome: cliShellHome,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess = child;
    child.stdout?.on("data", (chunk) => output.stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.stderr.push(String(chunk)));
    await waitForServer(apiBase, child, output,
      path.join(paperclipHome, "instances", paperclipInstanceId, "runtime-info.json"));
  }

  beforeAll(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-company-cli-e2e-"));
    configPath = path.join(tempRoot, "config", "config.json");
    exportDir = path.join(tempRoot, "exported-company");
    paperclipHome = path.join(tempRoot, "paperclip-home");
    cliShellHome = path.join(tempRoot, "shell-home");
    paperclipInstanceId = "company-cli-e2e";
    mkdirSync(paperclipHome, { recursive: true });
    mkdirSync(cliShellHome, { recursive: true });

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-cli-db-");

    serverPort = await getAvailablePort();
    writeTestConfig(configPath, tempRoot, serverPort, tempDb.connectionString);
    apiBase = `http://127.0.0.1:${serverPort}`;
    await startServer();
  }, 60_000);

  afterAll(async () => {
    await stopServerProcess(serverProcess);
    if (apiBase) await waitForServerPortClosed(apiBase);
    await tempDb?.cleanup();
    if (tempRoot) {
      // Native imports materialize immutable instruction/skill directories.
      // Restore write access only inside this fixture, without following links.
      const makeWritable = (directory: string) => {
        const stat = lstatSync(directory);
        if (!stat.isDirectory()) return;
        chmodSync(directory, stat.mode | 0o700);
        for (const entry of readdirSync(directory)) makeWritable(path.join(directory, entry));
      };
      makeWritable(tempRoot);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves reviewed native and legacy hire configurations through a server restart and approval", async () => {
    type Agent = { id: string; companyId: string; status: string; adapterType: string; adapterConfig: Record<string, unknown>; runtimeConfig: Record<string, unknown> };
    type Approval = { id: string; companyId: string; status: string; requestedByAgentId: string | null; payload: Record<string, unknown> };
    const company = await api<{ id: string }>(apiBase, "/api/companies", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Pending runner restart ${Date.now()}` }),
    });
    await api(apiBase, `/api/companies/${company.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireBoardApprovalForNewAgents: true }),
    });
    const pendingHires: Array<{ agent: Agent; approval: Approval }> = [];
    for (const runner of [undefined, "legacy"] as const) {
      const hire = await api<{ agent: Agent; approval: Approval }>(apiBase, `/api/companies/${company.id}/agent-hires`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: runner ? "Reviewed legacy coder" : "Reviewed automatic coder", role: "engineer",
          adapterType: "codex_local", adapterConfig: { model: "gpt-5.6-sol" },
          ...(runner ? { runner } : {}),
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
          instructionsBundle: { files: { "AGENTS.md": "Wait for an assigned task after board approval." } },
        }),
      });
      expect(hire.agent.status).toBe("pending_approval");
      expect(hire.agent.adapterType).toBe(runner ? "codex_local" : "paperclip_runner");
      if (!runner) expect(hire.agent.adapterConfig.provider).toBe("codex");
      expect(hire.approval).toMatchObject({ companyId: company.id, status: "pending", requestedByAgentId: null });
      expect(hire.approval.payload).toMatchObject({
        agentId: hire.agent.id, adapterType: hire.agent.adapterType,
        adapterConfig: hire.agent.adapterConfig, runtimeConfig: hire.agent.runtimeConfig,
      });
      const frozenEdit = await fetch(`${apiBase}/api/agents/${hire.agent.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Unreviewed change" }),
      });
      expect(frozenEdit.status).toBe(409);
      pendingHires.push(hire);
    }

    const oldProcessId = serverProcess!.pid;
    await stopServerProcess(serverProcess);
    await waitForServerPortClosed(apiBase);
    await startServer();
    expect(serverProcess!.pid).not.toBe(oldProcessId);
    for (const { agent, approval } of pendingHires) {
      const persistedApproval = await api<Approval>(apiBase, `/api/approvals/${approval.id}`);
      expect(persistedApproval.status).toBe("pending");
      expect(persistedApproval.payload).toEqual(approval.payload);
      const persistedAgent = await api<Agent>(apiBase, `/api/agents/${agent.id}`);
      expect(persistedAgent).toMatchObject({ status: "pending_approval", companyId: company.id, adapterType: agent.adapterType });
      expect(persistedAgent.adapterConfig).toEqual(agent.adapterConfig);
      expect(persistedAgent.runtimeConfig).toEqual(agent.runtimeConfig);
      await api(apiBase, `/api/approvals/${approval.id}/approve`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionNote: "Approve the configuration reviewed before restart" }),
      });
      const activated = await api<Agent>(apiBase, `/api/agents/${agent.id}`);
      expect(activated).toMatchObject({ status: "idle", companyId: company.id, adapterType: agent.adapterType });
      expect(activated.adapterConfig).toEqual(agent.adapterConfig);
      expect(activated.runtimeConfig).toEqual(agent.runtimeConfig);
      const decided = await api<Approval>(apiBase, `/api/approvals/${approval.id}`);
      expect(decided.status).toBe("approved");
      expect(decided.payload).toEqual(approval.payload);
    }
    expect(await api(apiBase, `/api/companies/${company.id}/heartbeat-runs`)).toEqual([]);
  }, 60_000);

  it("exports a company package and imports it into new and existing companies", async () => {
    expect(serverProcess).not.toBeNull();

    const cliContext = await runCliJson<{
      contextPath: string;
      profileName: string;
      profile: { apiBase?: string };
    }>(
      ["context", "set", "--profile", "isolation-check", "--api-base", "https://example.test"],
      {
        configPath,
        paperclipHome,
        instanceId: paperclipInstanceId,
        shellHome: cliShellHome,
        includeConfigArg: false,
      },
    );

    const expectedContextPath = path.join(paperclipHome, "context.json");
    const leakedContextPath = path.join(cliShellHome, ".paperclip", "context.json");
    expect(cliContext.contextPath).toBe(expectedContextPath);
    expect(cliContext.profileName).toBe("isolation-check");
    expect(cliContext.profile.apiBase).toBe("https://example.test");
    expect(existsSync(expectedContextPath)).toBe(true);
    expect(existsSync(leakedContextPath)).toBe(false);
    rmSync(expectedContextPath, { force: true });
    expect(existsSync(expectedContextPath)).toBe(false);

    const sourceCompany = await api<{ id: string; name: string; issuePrefix: string }>(apiBase, "/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `CLI Export Source ${Date.now()}` }),
    });
    await api(apiBase, `/api/companies/${sourceCompany.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireBoardApprovalForNewAgents: false }),
    });

    const sourceAgent = await api<{ id: string; name: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Export Engineer",
          role: "engineer",
          adapterType: "claude_local",
          adapterConfig: {},
          instructionsBundle: {
            files: {
              "AGENTS.md": "You verify company portability.",
            },
          },
        }),
      },
    );

    const sourceProject = await api<{ id: string; name: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/projects`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Portability Verification",
          status: "in_progress",
        }),
      },
    );

    const largeIssueDescription = `Round-trip the company package through the CLI.\n\n${"portable-data ".repeat(12_000)}`;

    const sourceIssue = await api<{ id: string; title: string; identifier: string }>(
      apiBase,
      `/api/companies/${sourceCompany.id}/issues`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Validate company import/export",
          description: largeIssueDescription,
          status: "todo",
          projectId: sourceProject.id,
          assigneeAgentId: sourceAgent.id,
        }),
      },
    );

    const exportResult = await runCliJson<{
      ok: boolean;
      out: string;
      filesWritten: number;
    }>(
      [
        "company",
        "export",
        sourceCompany.id,
        "--out",
        exportDir,
        "--include",
        "company,agents,projects,issues",
      ],
      {
        apiBase,
        configPath,
        paperclipHome,
        instanceId: paperclipInstanceId,
        shellHome: cliShellHome,
      },
    );

    expect(exportResult.ok).toBe(true);
    expect(exportResult.filesWritten).toBeGreaterThan(0);
    expect(readFileSync(path.join(exportDir, "COMPANY.md"), "utf8")).toContain(sourceCompany.name);
    expect(readFileSync(path.join(exportDir, ".paperclip.yaml"), "utf8")).toContain('schema: "paperclip/v1"');

    const importedNew = await runCliJson<{
      company: { id: string; name: string; action: string };
      agents: Array<{ id: string | null; action: string; name: string }>;
    }>(
      [
        "company",
        "import",
        exportDir,
        "--target",
        "new",
        "--new-company-name",
        `Imported ${sourceCompany.name}`,
        "--include",
        "company,agents,projects,issues",
        "--yes",
      ],
      {
        apiBase,
        configPath,
        paperclipHome,
        instanceId: paperclipInstanceId,
        shellHome: cliShellHome,
      },
    );

    expect(importedNew.company.action).toBe("created");
    expect(importedNew.agents).toHaveLength(1);
    expect(importedNew.agents[0]?.action).toBe("created");

    const importedAgents = await api<Array<{ id: string; name: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/agents`,
    );
    const importedProjects = await api<Array<{ id: string; name: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/projects`,
    );
    const importedIssues = await api<Array<{ id: string; title: string; identifier: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/issues`,
    );
    const importedMatchingIssues = importedIssues.filter((issue) => issue.title === sourceIssue.title);

    expect(importedAgents.map((agent) => agent.name)).toContain(sourceAgent.name);
    expect(importedProjects.map((project) => project.name)).toContain(sourceProject.name);
    expect(importedMatchingIssues).toHaveLength(1);

    const previewExisting = await runCliJson<{
      errors: string[];
      plan: {
        companyAction: string;
        agentPlans: Array<{ action: string }>;
        projectPlans: Array<{ action: string }>;
        issuePlans: Array<{ action: string }>;
      };
    }>(
      [
        "company",
        "import",
        exportDir,
        "--target",
        "existing",
        "--company-id",
        importedNew.company.id,
        "--include",
        "company,agents,projects,issues",
        "--collision",
        "rename",
        "--dry-run",
      ],
      {
        apiBase,
        configPath,
        paperclipHome,
        instanceId: paperclipInstanceId,
        shellHome: cliShellHome,
      },
    );

    expect(previewExisting.errors).toEqual([]);
    expect(previewExisting.plan.companyAction).toBe("none");
    expect(previewExisting.plan.agentPlans.some((plan) => plan.action === "create")).toBe(true);
    expect(previewExisting.plan.projectPlans.some((plan) => plan.action === "create")).toBe(true);
    expect(previewExisting.plan.issuePlans.some((plan) => plan.action === "create")).toBe(true);

    const importedExisting = await runCliJson<{
      company: { id: string; action: string };
      agents: Array<{ id: string | null; action: string; name: string }>;
    }>(
      [
        "company",
        "import",
        exportDir,
        "--target",
        "existing",
        "--company-id",
        importedNew.company.id,
        "--include",
        "company,agents,projects,issues",
        "--collision",
        "rename",
        "--yes",
      ],
      {
        apiBase,
        configPath,
        paperclipHome,
        instanceId: paperclipInstanceId,
        shellHome: cliShellHome,
      },
    );

    expect(importedExisting.company.action).toBe("unchanged");
    expect(importedExisting.agents.some((agent) => agent.action === "created")).toBe(true);

    const twiceImportedAgents = await api<Array<{ id: string; name: string; metadata?: Record<string, unknown> | null }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/agents`,
    );
    const twiceImportedProjects = await api<Array<{ id: string; name: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/projects`,
    );
    const twiceImportedIssues = await api<Array<{ id: string; title: string; identifier: string }>>(
      apiBase,
      `/api/companies/${importedNew.company.id}/issues`,
    );
    const twiceImportedMatchingIssues = twiceImportedIssues.filter((issue) => issue.title === sourceIssue.title);
    const twiceImportedPortableAgents = twiceImportedAgents.filter(isPortableAgent);

    expect(twiceImportedPortableAgents).toHaveLength(2);
    expect(new Set(twiceImportedPortableAgents.map((agent) => agent.name)).size).toBe(2);
    expect(twiceImportedProjects).toHaveLength(2);
    expect(twiceImportedMatchingIssues).toHaveLength(2);
    expect(new Set(twiceImportedMatchingIssues.map((issue) => issue.identifier)).size).toBe(2);

    const zipPath = path.join(tempRoot, "exported-company.zip");
    const portableFiles: Record<string, string> = {};
    collectTextFiles(exportDir, exportDir, portableFiles);
    writeFileSync(zipPath, createStoredZipArchive(portableFiles, "paperclip-demo"));

    const importedFromZip = await runCliJson<{
      company: { id: string; name: string; action: string };
      agents: Array<{ id: string | null; action: string; name: string }>;
    }>(
      [
        "company",
        "import",
        zipPath,
        "--target",
        "new",
        "--new-company-name",
        `Zip Imported ${sourceCompany.name}`,
        "--include",
        "company,agents,projects,issues",
        "--yes",
      ],
      {
        apiBase,
        configPath,
        paperclipHome,
        instanceId: paperclipInstanceId,
        shellHome: cliShellHome,
      },
    );

    expect(importedFromZip.company.action).toBe("created");
    expect(importedFromZip.agents.some((agent) => agent.action === "created")).toBe(true);
  }, 90_000);
});
