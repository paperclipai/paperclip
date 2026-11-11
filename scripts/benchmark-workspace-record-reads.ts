import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { companies, createDb, executionWorkspaces, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import { executionWorkspaceService } from "../server/src/services/execution-workspaces.js";

const run = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-record-benchmark-"));
const repo = path.join(root, "repo");
const worktree = path.join(root, "worktree");
const residentMiB = Number(process.argv.find(arg => arg.startsWith("--resident-mib="))?.split("=")[1] ?? 0);
assert.ok(Number.isInteger(residentMiB) && residentMiB >= 0 && residentMiB <= 2048);
const previousTrace = process.env.GIT_TRACE;
const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
try {
  await fs.mkdir(repo);
  const git = (...args: string[]) => run("git", ["-C", repo, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Workspace benchmark");
  await git("config", "user.email", "benchmark@paperclip.local");
  await fs.writeFile(path.join(repo, "README.md"), "Synthetic workspace\n");
  await git("add", "README.md");
  await git("commit", "-m", "Fixture");
  await git("worktree", "add", "-b", "fixture", worktree);
  database = await startEmbeddedPostgresTestDatabase("workspace-record-benchmark-");
  db = createDb(database.connectionString);
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic workspace reads", issuePrefix: "BENCH" });
  const rows = await db.insert(executionWorkspaces).values(Array.from({ length: 20 }, (_, index) => ({
    companyId, name: `Fixture ${index}`, mode: "isolated_workspace", strategyType: "git_worktree",
    cwd: worktree, providerRef: worktree, providerType: "git_worktree", baseRef: "main", branchName: "fixture",
  }))).returning();
  const service = executionWorkspaceService(db);
  const resident = Array.from({ length: residentMiB }, () => Buffer.alloc(1024 * 1024, 1));
  const persisted = (workspace: NonNullable<Awaited<ReturnType<typeof service.getById>>>) => {
    const { runtimeServices: _services, deliveryState: _delivery, ...record } = workspace;
    return record;
  };
  const results = [];
  let expected: ReturnType<typeof persisted>[] | undefined;
  await service.getStoredById(companyId, rows[0].id);
  for (const mode of ["detail", "stored"] as const) {
    const trace = path.join(root, `${mode}.trace`);
    process.env.GIT_TRACE = trace;
    const start = performance.now();
    const records = [];
    for (const row of rows) {
      const workspace = mode === "detail"
        ? await service.getById(row.id)
        : await service.getStoredById(companyId, row.id);
      assert.ok(workspace);
      records.push(persisted(workspace));
    }
    const wallMs = performance.now() - start;
    if (expected) assert.deepEqual(records, expected);
    else expected = records;
    const traceText = await fs.readFile(trace, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    results.push({ mode, reads: rows.length, wallMs, gitCommands: traceText.split("\n").filter(line => line.includes("built-in: git ")).length });
  }
  assert.equal(results[1].gitCommands, 0);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    residentMiB: resident.length, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    equalPersistedRecords: true, results }, null, 2));
} finally {
  if (previousTrace === undefined) delete process.env.GIT_TRACE;
  else process.env.GIT_TRACE = previousTrace;
  try {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
