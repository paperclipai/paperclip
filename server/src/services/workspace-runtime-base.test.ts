import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { nestedRepositoryBaseCandidates } from "./nested-repository-worktrees.js";
import { resolveWorkspaceRuntimeBase } from "./workspace-runtime-base.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-base-"));
  roots.push(home);
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  return { companyId: "company-one", projectId: "project-one", workspaceCwd: path.join(home, "target"),
    projectWorkspace: { cwd: null, repoUrl: "https://example.com/owner/repo.git" } };
}

function checkout(cwd: string, origin: string) {
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", origin]);
}

describe("runtime registered base resolution", () => {
  it("resolves a null-cwd managed registration without selecting the target", async () => {
    const input = fixture();
    const base = resolveManagedProjectWorkspaceDir({ ...input, repoName: "repo" });
    checkout(base, input.projectWorkspace.repoUrl);
    expect(await resolveWorkspaceRuntimeBase(input)).toBe(base);
    expect(base).not.toBe(input.workspaceCwd);
  });

  it("uses the registered collision alternate only after verifying its origin", async () => {
    const input = fixture();
    const [primary, alternate] = nestedRepositoryBaseCandidates({ ...input, repoUrl: input.projectWorkspace.repoUrl });
    checkout(primary, "https://example.com/other/repo.git");
    checkout(alternate, input.projectWorkspace.repoUrl);
    expect(await resolveWorkspaceRuntimeBase(input)).toBe(alternate);
  });

  it("rejects missing, wrong-origin and cross-company checkouts", async () => {
    const input = fixture();
    await expect(resolveWorkspaceRuntimeBase(input)).rejects.toThrow(/verified registered base/);
    const base = resolveManagedProjectWorkspaceDir({ ...input, repoName: "repo" });
    checkout(base, "https://example.com/other/repo.git");
    await expect(resolveWorkspaceRuntimeBase(input)).rejects.toThrow(/verified registered base/);
    await expect(resolveWorkspaceRuntimeBase({ ...input, companyId: "company-two" })).rejects.toThrow(/verified registered base/);
  });

  it("rejects a symlink alias even when it points to the registered repository", async () => {
    const input = fixture();
    const base = resolveManagedProjectWorkspaceDir({ ...input, repoName: "repo" });
    const elsewhere = path.join(path.dirname(input.workspaceCwd), "elsewhere");
    checkout(elsewhere, input.projectWorkspace.repoUrl);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.symlinkSync(elsewhere, base);
    await expect(resolveWorkspaceRuntimeBase(input)).rejects.toThrow(/verified registered base/);
  });

  it("retains explicit configured directories and unregistered workspace behavior", async () => {
    const input = fixture();
    expect(await resolveWorkspaceRuntimeBase({ ...input, projectWorkspace: { ...input.projectWorkspace, cwd: input.workspaceCwd } })).toBe(input.workspaceCwd);
    expect(await resolveWorkspaceRuntimeBase({ ...input, projectWorkspace: null })).toBe(input.workspaceCwd);
  });
});
