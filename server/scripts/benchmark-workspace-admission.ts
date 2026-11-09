import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  companies,
  createDb,
  executionWorkspaceRepositoryAccess,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";

import { createAgentLifecycle } from "../src/services/agent-lifecycle.js";

const execFile = promisify(execFileCallback);

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

function latency(name: string, fallback: number) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function count(name: string, fallback: number) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

async function insertBatches<T extends Record<string, unknown>>(
  insert: (values: T[]) => Promise<unknown>,
  values: T[],
) {
  for (let offset = 0; offset < values.length; offset += 500) {
    await insert(values.slice(offset, offset + 500));
  }
}

const workspaceCount = count("--workspaces", 8_516);
const rootWorkspaceCount = count("--root-workspaces", 5_315);
const sourceEntryCount = count("--source-entries", 17_256);
const isolatedSourceEntryCount = count("--isolated-source-entries", 10_630);
const readerEntryCount = count("--readers", 51);
const rootReaderCount = count("--root-readers", 28);
const otherAccessEntryCount = count("--other-access-entries", 34);
const realpathDelayMs = latency("--realpath-delay-ms", 0);
const distinctCwds = process.argv.includes("--distinct-cwds");
if (workspaceCount < 1 || rootWorkspaceCount < 1 || rootWorkspaceCount > workspaceCount) {
  throw new Error("Need at least one workspace; root workspaces must be between one and the workspace total");
}
if (readerEntryCount < rootReaderCount) {
  throw new Error("Root reader count cannot exceed the company-wide reader total");
}

const configuredService = option("--service", "");
const serviceUrl = configuredService
  ? pathToFileURL(path.resolve(configuredService))
  : new URL("../src/services/execution-workspace-repositories.ts", import.meta.url);

let measuring = false;
let realpathCalls = 0;
let realpathIoMs = 0;
let injectedWaitMs = 0;
const actualRealpath = fs.realpath.bind(fs);
fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
  if (!measuring) return actualRealpath(...args);
  const started = performance.now();
  try {
    return await actualRealpath(...args);
  } finally {
    realpathCalls += 1;
    realpathIoMs += performance.now() - started;
    if (realpathDelayMs > 0) {
      const waitStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, realpathDelayMs));
      injectedWaitMs += performance.now() - waitStarted;
    }
  }
}) as typeof fs.realpath;

const { executionWorkspaceRepositoryService } = await import(serviceUrl.href);

const temp = await startEmbeddedPostgresTestDatabase("paperclip-workspace-admission-bench-");
const db = createDb(temp.connectionString);
const scratchRoot = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-admission-")));
const repoRoot = path.join(scratchRoot, "shared-repository");
const unrelatedRoot = path.join(scratchRoot, "unrelated-workspaces");

try {
  await mkdir(repoRoot, { recursive: true });
  await mkdir(unrelatedRoot, { recursive: true });
  await execFile("git", ["init", "--quiet", "--initial-branch=main", repoRoot]);

  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const workspaceIds = Array.from({ length: workspaceCount }, () => randomUUID());
  const workspaceCwds = workspaceIds.map((_, index) => {
    const root = index < rootWorkspaceCount ? repoRoot : unrelatedRoot;
    return distinctCwds && index !== 0 ? path.join(root, `workspace-${index}`) : root;
  });
  if (distinctCwds) for (let offset = 0; offset < workspaceCwds.length; offset += 64) {
    await Promise.all(workspaceCwds.slice(offset, offset + 64).map(cwd => mkdir(cwd, { recursive: true })));
  }
  const runIds = Array.from({ length: Math.max(1, rootReaderCount) }, () => randomUUID());
  const now = new Date();
  const rootKey = createHash("sha256").update(repoRoot).digest("hex");
  const unrelatedKey = createHash("sha256").update(unrelatedRoot).digest("hex");

  await db.insert(companies).values({ id: companyId, name: "Synthetic workspace-admission benchmark", issuePrefix: "WAB" });
  await createAgentLifecycle(db).requestHire(companyId, {
    id: agentId,
    name: "Synthetic Codie",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }, { runnerResolved: true });

  await insertBatches((rows) => db.insert(executionWorkspaces).values(rows as never), workspaceIds.map((id, index) => ({
    id,
    companyId,
    name: `Synthetic workspace ${index}`,
    mode: "shared_workspace",
    strategyType: "project_primary",
    status: "active",
    cwd: workspaceCwds[index],
    providerType: "local_fs",
  })));

  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Synthetic assigned task",
    status: "in_progress",
    assigneeAgentId: agentId,
    executionWorkspaceId: workspaceIds[0],
    responsibleUserId: "local-board",
  });
  for (let offset = 0; offset < rootWorkspaceCount; offset += 500) {
    await db.update(executionWorkspaces).set({ sourceIssueId: issueId })
      .where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, workspaceIds.slice(offset, offset + 500))));
  }

  if (runIds.length) {
    await db.insert(heartbeatRuns).values(runIds.map((id) => ({
      id,
      companyId,
      agentId,
      scopeKind: "issue" as const,
      issueId,
      nativeIssueId: issueId,
      invocationSource: "on_demand",
      status: "completed",
      responsibleUserId: "local-board",
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      startedAt: now,
      finishedAt: now,
    })));
  }

  const accessRows: Array<typeof executionWorkspaceRepositoryAccess.$inferInsert> = [];
  for (let index = 0; index < sourceEntryCount; index++) {
    const isRootSource = index < rootWorkspaceCount;
    accessRows.push({
      companyId,
      rootKey: isRootSource ? rootKey : unrelatedKey,
      canonicalCwd: isRootSource ? repoRoot : unrelatedRoot,
      kind: "source",
      scopeId: isRootSource ? workspaceIds[index] : randomUUID(),
    });
  }
  for (let index = 0; index < isolatedSourceEntryCount; index++) {
    accessRows.push({ companyId, rootKey: unrelatedKey, canonicalCwd: unrelatedRoot, kind: "isolated_source", scopeId: randomUUID() });
  }
  for (let index = 0; index < readerEntryCount; index++) {
    const rootReader = index < rootReaderCount;
    accessRows.push({
      companyId,
      rootKey: rootReader ? rootKey : unrelatedKey,
      canonicalCwd: rootReader ? repoRoot : unrelatedRoot,
      kind: "reader",
      scopeId: rootReader ? runIds[index] : randomUUID(),
      issueId: rootReader ? issueId : randomUUID(),
      agentId: rootReader ? agentId : randomUUID(),
      responsibleUserId: "local-board",
    });
  }
  for (let index = 0; index < otherAccessEntryCount; index++) {
    accessRows.push({ companyId, rootKey: unrelatedKey, canonicalCwd: unrelatedRoot, kind: "repository", scopeId: randomUUID() });
  }
  await insertBatches((rows) => db.insert(executionWorkspaceRepositoryAccess).values(rows as never), accessRows);

  let queryCount = 0;
  let provenanceInsertCount = 0;
  const measuredDb = drizzle(db.$client, {
    schema: db._.fullSchema,
    logger: { logQuery(query: string) {
      if (!measuring) return;
      queryCount++;
      if (query.startsWith('insert into "execution_workspace_repository_access"')) provenanceInsertCount++;
    } },
  }) as typeof db;
  const service = executionWorkspaceRepositoryService(measuredDb);
  realpathCalls = 0;
  realpathIoMs = 0;
  process.stderr.write(`Starting admission benchmark: ${workspaceCount} workspaces, ${rootReaderCount} retained readers, ${realpathDelayMs} ms injected per realpath.\n`);
  measuring = true;
  const startedAt = performance.now();
  await service.prepareConfiguredRepositorySource({
    companyId,
    issueId,
    workspaceId: workspaceIds[0],
    cwd: repoRoot,
    sourceCwd: repoRoot,
    agentId,
    runId: runIds[0] ?? randomUUID(),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  measuring = false;
  process.stderr.write(`Admission service call completed in ${elapsedMs} ms.\n`);

  const retained = await db.select({ kind: executionWorkspaceRepositoryAccess.kind, scopeId: executionWorkspaceRepositoryAccess.scopeId })
    .from(executionWorkspaceRepositoryAccess).where(and(eq(executionWorkspaceRepositoryAccess.companyId, companyId),
      eq(executionWorkspaceRepositoryAccess.rootKey, rootKey), eq(executionWorkspaceRepositoryAccess.kind, "isolated_source")));
  const retainedIds = new Set(retained.map(row => row.scopeId));
  assert.equal(retainedIds.size, rootWorkspaceCount, "Every source must retain isolated-copy provenance");
  assert.ok(workspaceIds.slice(0, rootWorkspaceCount).every(id => retainedIds.has(id)), "Source provenance identities must match");
  const metadataRoot = await fs.realpath(path.join(repoRoot, ".git"));
  const metadataOwners = await db.select({ scopeId: executionWorkspaceRepositoryAccess.scopeId })
    .from(executionWorkspaceRepositoryAccess).where(and(eq(executionWorkspaceRepositoryAccess.companyId, companyId),
      eq(executionWorkspaceRepositoryAccess.rootKey, createHash("sha256").update(metadataRoot).digest("hex")),
      eq(executionWorkspaceRepositoryAccess.kind, "source")));
  const metadataOwnerIds = new Set(metadataOwners.map(row => row.scopeId));
  assert.equal(metadataOwnerIds.size, rootWorkspaceCount, "Git metadata must retain every source owner");
  assert.ok(workspaceIds.slice(0, rootWorkspaceCount).every(id => metadataOwnerIds.has(id)), "Git metadata source identities must match");
  const report = {
    elapsedMs,
    database: { queries: queryCount, provenanceInserts: provenanceInsertCount },
    realpath: {
      calls: realpathCalls,
      measuredIoMs: Math.round(realpathIoMs),
      injectedDelayPerCallMs: realpathDelayMs,
      summedInjectedWaitMs: Math.round(injectedWaitMs),
    },
    fixture: {
      workspaces: workspaceCount,
      sharedRootWorkspaces: rootWorkspaceCount,
      distinctWorkspaceCwds: new Set(workspaceCwds).size,
      repositoryAccessRows: accessRows.length,
      sourceRows: sourceEntryCount,
      isolatedSourceRows: isolatedSourceEntryCount,
      retainedReaders: rootReaderCount,
      allCompanyReaders: readerEntryCount,
      otherAccessRows: otherAccessEntryCount,
    },
    service: serviceUrl.pathname,
    note: "Synthetic local service benchmark only; no provider invocation.",
  };
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, (error) => error ? reject(error) : resolve());
  });
} finally {
  await temp.cleanup();
  await rm(scratchRoot, { recursive: true, force: true });
}
