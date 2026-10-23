import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeManagedProjectWorkspace } from "../services/managed-repository-checkout.ts";
import { realizeExecutionWorkspace, refreshRemoteTrackingBaseRef } from "../services/workspace-runtime.ts";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";
import {
  disposeGitWorkspaceSnapshot,
  fetchGitBundleIntoLocalRef,
  integrateImportedGitHead,
  readGitWorkspaceSnapshot,
  withShallowGitWorkspaceClone,
} from "@paperclipai/adapter-utils/git-workspace-sync";

const execute = promisify(execFile);
const directories: string[] = [];
const git = async (cwd: string, ...args: string[]) =>
  (await execute("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(authenticated = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-promisor-"));
  directories.push(directory);
  const source = path.join(directory, "source");
  await fs.mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "user.email", "fixture@example.test");
  await fs.writeFile(path.join(source, "content"), "archived content");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "Archived content");
  await git(source, "branch", "archived");
  await fs.writeFile(path.join(source, "content"), "current content");
  await git(source, "commit", "-am", "Current content");
  await git(source, "config", "uploadpack.allowFilter", "true");
  await git(source, "config", "uploadpack.allowAnySHA1InWant", "true");
  const wrapper = path.join(directory, "upload-pack");
  await fs.writeFile(wrapper, '#!/bin/sh\n[ "$FIXTURE_GIT_AUTH" = "allowed" ] || exit 97\nexec git-upload-pack "$@"\n', { mode: 0o700 });
  const repoUrl = authenticated ? `ext::${wrapper} ${source}` : pathToFileURL(source).href;
  const auth = { configArgs: ["-c", "protocol.ext.allow=always"], env: { FIXTURE_GIT_AUTH: "allowed" } };
  const resolveGitAuth = vi.fn(async () => authenticated ? auth : null);
  const checkout = path.join(directory, "checkout");
  vi.stubEnv("PAPERCLIP_MANAGED_CLONE_FILTER", "blob:none");
  await materializeManagedProjectWorkspace(checkout, { repoUrl, resolveGitAuth });
  expect(await git(checkout, "config", "remote.origin.promisor")).toBe("true");
  return { directory, source, repoUrl, checkout, resolveGitAuth };
}

function realize(input: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}, recorder?: WorkspaceOperationRecorder) {
  return realizeExecutionWorkspace({
    base: { baseCwd: input.checkout, source: "project_primary", projectId: "project", workspaceId: "workspace", repoUrl: input.repoUrl, repoRef: "origin/main" },
    config: { workspaceStrategy: { type: "git_worktree", worktreeParentDir: path.join(input.directory, "worktrees"), ...extra } },
    issue: { id: "issue", identifier: "FIX-1", title: "Partial clone" },
    agent: { id: "agent", name: "Fixture", companyId: "company" },
    resolveGitAuth: input.resolveGitAuth,
    recorder,
  });
}

describe("authenticated promisor worktrees", () => {
  it("materializes a moved base with its new blobs", async () => {
    const input = await fixture();
    await fs.writeFile(path.join(input.source, "content"), "moved base content");
    await git(input.source, "commit", "-am", "Move base");
    await refreshRemoteTrackingBaseRef(input.checkout, "origin/main", input.resolveGitAuth);
    const blob = await git(input.source, "rev-parse", "main:content");
    expect(await git(input.checkout, "rev-list", "--objects", "--missing=print", "origin/main")).not.toContain(`?${blob}`);
    const workspace = await realize(input);
    expect(await fs.readFile(path.join(workspace.cwd, "content"), "utf8")).toBe("moved base content");
    expect(await git(input.checkout, "rev-parse", "origin/main")).toBe(await git(input.source, "rev-parse", "main"));
  });

  it.each([false, true])("hydrates a pre-clone branch with recorder=%s", async recorded => {
    const input = await fixture();
    await git(input.checkout, "branch", "archived", "origin/archived");
    const commands: string[] = [];
    const recorder = recorded ? {
      recordOperation: async (operation: { command?: string; run: () => Promise<unknown> }) => {
        commands.push(operation.command ?? "");
        await operation.run();
      },
    } as unknown as WorkspaceOperationRecorder : undefined;
    const workspace = await realize(input, { existingBranch: "archived" }, recorder);
    expect(await fs.readFile(path.join(workspace.cwd, "content"), "utf8")).toBe("archived content");
    expect(commands.join("\n")).not.toContain("protocol.ext");
    expect(commands.join("\n")).not.toContain("FIXTURE_GIT_AUTH");
    if (recorded) expect(commands.some(command => command.includes("worktree add"))).toBe(true);
  });

  it.each([false, true])("blocks credential-capturing checkout hooks with recorder=%s", async recorded => {
    const input = await fixture();
    await git(input.checkout, "branch", "archived", "origin/archived");
    const capture = path.join(input.directory, "captured-auth");
    vi.stubEnv("FIXTURE_HOOK_CAPTURE", capture);
    await fs.writeFile(path.join(input.checkout, ".git", "hooks", "post-checkout"),
      '#!/bin/sh\nprintf %s "$FIXTURE_GIT_AUTH" > "$FIXTURE_HOOK_CAPTURE"\n', { mode: 0o700 });
    const recorder = recorded ? {
      recordOperation: async (operation: { run: () => Promise<unknown> }) => operation.run(),
    } as unknown as WorkspaceOperationRecorder : undefined;
    const workspace = await realize(input, { existingBranch: "archived" }, recorder);
    expect(await fs.readFile(path.join(workspace.cwd, "content"), "utf8")).toBe("archived content");
    await expect(fs.stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish a filtered checkout as a complete object cache", async () => {
    const input = await fixture(false);
    const cache = path.join(input.directory, "cache", "company");
    await materializeManagedProjectWorkspace(path.join(input.directory, "filtered"), { repoUrl: input.repoUrl, objectCacheCompanyDirectory: cache });
    expect(await fs.readdir(cache)).toEqual([]);
    vi.stubEnv("PAPERCLIP_MANAGED_CLONE_FILTER", "");
    await materializeManagedProjectWorkspace(path.join(input.directory, "full"), { repoUrl: input.repoUrl, objectCacheCompanyDirectory: cache });
    expect((await fs.readdir(cache)).length).toBe(1);
  });

  it("returns a sandbox commit while the promisor remote is unavailable", async () => {
    const input = await fixture(false);
    await git(input.checkout, "remote", "set-url", "origin", pathToFileURL(path.join(input.directory, "unavailable")).href);
    const snapshot = await readGitWorkspaceSnapshot(input.checkout);
    expect(snapshot).not.toBeNull();
    const bundlePath = path.join(input.directory, "return.bundle");
    try {
      await withShallowGitWorkspaceClone({ localDir: input.checkout, snapshot: snapshot! }, async clone => {
        await git(clone, "config", "user.name", "Fixture");
        await git(clone, "config", "user.email", "fixture@example.test");
        await fs.writeFile(path.join(clone, "content"), "sandbox result");
        await git(clone, "commit", "-am", "Sandbox result");
        await git(clone, "update-ref", "refs/paperclip/export", "HEAD");
        await git(clone, "bundle", "create", bundlePath, "refs/paperclip/export");
      });
      const importedHead = await fetchGitBundleIntoLocalRef({ localDir: input.checkout, bundlePath, exportRef: "refs/paperclip/export", importedRef: "refs/paperclip/import", baseSha: snapshot!.headCommit });
      await integrateImportedGitHead({ localDir: input.checkout, importedHead, baseline: snapshot! });
      await git(input.checkout, "reset", "--hard", "HEAD");
      expect(await fs.readFile(path.join(input.checkout, "content"), "utf8")).toBe("sandbox result");
    } finally {
      await disposeGitWorkspaceSnapshot(snapshot!);
    }
  });
});
