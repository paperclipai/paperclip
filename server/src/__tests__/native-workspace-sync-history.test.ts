import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runLocalGit } from "@paperclipai/adapter-utils/git-workspace-sync";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";

const runner: CommandManagedRuntimeRunner = {
  execute: (input) => new Promise((resolve) => {
    const child = execFile(input.command, input.args ?? [], {
      cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr,
    }));
    child.stdin?.end(input.stdin ?? "");
  }),
};

async function git(cwd: string, ...args: string[]) {
  return (await runLocalGit(cwd, args)).stdout.trim();
}

describe("native warm workspace Git history", () => {
  const oldHome = process.env.PAPERCLIP_HOME;
  const oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
  const roots: string[] = [];
  afterEach(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each(["unchanged", "host_commit", "host_branch", "remote_commit", "nested_commit"] as const)(
    "checks Git identity before reusing a warm sandbox: %s", async (change) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-warm-history-"));
      roots.push(root);
      process.env.PAPERCLIP_HOME = path.join(root, "home");
      process.env.PAPERCLIP_INSTANCE_ID = "test";
      const host = path.join(root, "host");
      const remote = path.join(root, "remote");
      async function initRepo(dir: string) {
        await mkdir(dir, { recursive: true });
        await git(dir, "init", "-b", "work");
        await git(dir, "config", "user.name", "Test");
        await git(dir, "config", "user.email", "test@paperclip.dev");
        await writeFile(path.join(dir, "file.txt"), "unchanged contents\n");
        await git(dir, "add", ".");
        await git(dir, "commit", "-m", "base");
      }
      await initRepo(host);
      const nestedPath = path.join(".paperclip-repositories", "nested");
      if (change === "nested_commit") await initRepo(path.join(host, nestedPath));
      const lease = { id: "lease", providerLeaseId: "sandbox", metadata: {} } as EnvironmentLease;
      let runnerProfileJson: Record<string, unknown> = {};
      // Persist the real service's descriptors and stamps; only the DB query
      // plumbing is in memory. Git, staging, warm adoption, and restore are real.
      const db = {
        select: () => {
          const query = {
            from: () => query, where: () => query, for: () => query,
            limit: async () => [{ runnerProfileJson, metadata: lease.metadata }],
          };
          return query;
        },
        update: (table: unknown) => ({
          set: (value: { runnerProfileJson?: Record<string, unknown>; metadata?: Record<string, unknown> }) => ({
            where: async () => {
              if (table === heartbeatRuns) runnerProfileJson = value.runnerProfileJson!;
              else lease.metadata = value.metadata!;
            },
          }),
        }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote", transport: "sandbox", providerKey: "test", leaseId: lease.id,
        remoteCwd: remote, runner, timeoutMs: 30_000,
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "sandbox" },
      };
      const input = { db: db as unknown as Db, companyId: "company", workspaceId: "workspace", workspaceLocalDir: host, lease, target };
      const first = (await prepareNativeWorkspaceSync({ ...input, runId: "first" }))!;
      expect(first.mode).toBe("host_current");
      await first.restoreWorkspace();
      await first.cleanup();

      if (change === "host_commit" || change === "nested_commit") {
        await git(change === "nested_commit" ? path.join(host, nestedPath) : host, "commit", "--allow-empty", "-m", "host only");
      } else if (change === "host_branch") {
        await git(host, "checkout", "-b", "other");
      } else if (change === "remote_commit") {
        await git(remote, "-c", "user.name=Test", "-c", "user.email=test@paperclip.dev", "commit", "--allow-empty", "-m", "remote only");
      }
      const expectedHead = await git(host, "rev-parse", "HEAD");
      const expectedBranch = await git(host, "symbolic-ref", "--short", "HEAD");
      const nestedHead = change === "nested_commit" ? await git(path.join(host, nestedPath), "rev-parse", "HEAD") : null;
      runnerProfileJson = {};
      const second = (await prepareNativeWorkspaceSync({ ...input, runId: "second", target: {
        ...target, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "sandbox" },
      } }))!;
      try {
        expect(second.mode).toBe(change === "unchanged" ? "adopt_remote" : "host_current");
        expect(await git(remote, "rev-parse", "HEAD")).toBe(expectedHead);
        expect(await git(remote, "symbolic-ref", "--short", "HEAD")).toBe(expectedBranch);
        await second.restoreWorkspace();
        expect(await git(host, "rev-parse", "HEAD")).toBe(expectedHead);
        if (nestedHead) {
          expect(await git(path.join(remote, nestedPath), "rev-parse", "HEAD")).toBe(nestedHead);
          expect(await git(path.join(host, nestedPath), "rev-parse", "HEAD")).toBe(nestedHead);
        }
      } finally { await second.cleanup(); }
    }, 30_000,
  );
});
