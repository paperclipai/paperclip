import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePersistedGitWorkspaceSource } from "../services/persisted-workspace-source.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "persisted-source-")));
  roots.push(root);
  const original = path.join(root, "original");
  const replacement = path.join(root, "replacement");
  const worktree = path.join(root, "task");
  for (const repo of [original, replacement]) {
    await exec("git", ["init", repo]);
    await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
    await exec("git", ["-C", repo, "remote", "add", "origin", `https://example.invalid/${path.basename(repo)}.git`]);
  }
  await exec("git", ["-C", original, "worktree", "add", "-b", "task", worktree]);
  await fs.writeFile(path.join(worktree, "retained.txt"), "keep this work\n");
  const workspace = {
    id: "execution-workspace", companyId: "company", projectId: "project", projectWorkspaceId: null,
    repoUrl: "https://example.invalid/original.git", baseRef: "HEAD", cwd: worktree, providerRef: worktree,
  };
  return { root, original, replacement, worktree, workspace, input: {
    companyId: "company", projectId: "project", explicitProjectWorkspaceId: null,
    workspace, boundProjectWorkspace: null, candidateBaseCwds: [original], managedSourceRoot: root,
  } };
}

describe("persisted Git workspace source", () => {
  it("keeps the original registered source after its project binding is deleted", async () => {
    const { original, replacement, worktree, input } = await fixture();
    const source = await resolvePersistedGitWorkspaceSource(input);
    expect(source).toBe(original);
    expect(source).not.toBe(replacement);
    expect(input.workspace.projectWorkspaceId).toBeNull();
    expect(await fs.readFile(path.join(worktree, "retained.txt"), "utf8")).toBe("keep this work\n");
  });

  it.each(["companyId", "projectId"] as const)("rejects a foreign %s before source inspection or materialization", async field => {
    const { input } = await fixture();
    const materializeOriginalRepository = vi.fn();
    await expect(resolvePersistedGitWorkspaceSource({ ...input, workspace: { ...input.workspace, [field]: "foreign" },
      materializeOriginalRepository })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_scope_mismatch" } } });
    expect(materializeOriginalRepository).not.toHaveBeenCalled();
  });

  it("rejects an explicit new project selection without rebinding the old task source", async () => {
    const { input } = await fixture();
    await expect(resolvePersistedGitWorkspaceSource({ ...input, explicitProjectWorkspaceId: "replacement" })).rejects.toMatchObject({
      code: "workspace_validation_failed", resultJson: { workspaceValidation: { reasonCode: "explicit_project_workspace_conflict" } },
    });
  });

  it.each([null, { id: "bound", companyId: "foreign", projectId: "project", cwd: null },
    { id: "bound", companyId: "company", projectId: "foreign", cwd: null }])("rejects an unverified non-null project binding (%j)", async binding => {
    const { input } = await fixture();
    await expect(resolvePersistedGitWorkspaceSource({ ...input, workspace: { ...input.workspace, projectWorkspaceId: "bound" },
      boundProjectWorkspace: binding })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_scope_mismatch" } } });
  });

  it("rejects a supplied source binding when the saved association is null", async () => {
    const { original, input } = await fixture();
    await expect(resolvePersistedGitWorkspaceSource({ ...input,
      boundProjectWorkspace: { id: "foreign-binding", companyId: "company", projectId: "project", cwd: original },
    })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_scope_mismatch" } } });
  });

  it("does not trust another Git owner just because its origin matches", async () => {
    const { original, replacement, input } = await fixture();
    await exec("git", ["-C", replacement, "remote", "set-url", "origin", input.workspace.repoUrl]);
    await expect(resolvePersistedGitWorkspaceSource({ ...input, candidateBaseCwds: [replacement] })).rejects.toMatchObject({
      resultJson: { workspaceValidation: { reasonCode: "source_registration_unproven" } },
    });
    expect(original).not.toBe(replacement);
  });

  it("uses the stored origin identity without transport-only URL rewrites", async () => {
    const { original, input } = await fixture();
    await exec("git", ["-C", original, "config", "url.ssh://git@example.invalid/.insteadOf", "https://example.invalid/"]);
    expect((await exec("git", ["-C", original, "remote", "get-url", "origin"])).stdout.trim()).not.toBe(input.workspace.repoUrl);
    expect(await resolvePersistedGitWorkspaceSource(input)).toBe(original);
  });

  it("rejects a symlink that redirects a managed source into another repository", async () => {
    const { root, original, input } = await fixture();
    const alias = path.join(root, "scoped", "original");
    await fs.mkdir(path.dirname(alias));
    await fs.symlink(original, alias);
    await expect(resolvePersistedGitWorkspaceSource({ ...input, candidateBaseCwds: [alias] })).rejects.toMatchObject({
      resultJson: { workspaceValidation: { reasonCode: "source_registration_unproven" } },
    });
  });

  it("rejects multiple origin URLs even if the last one matches the saved repository", async () => {
    const { original, input } = await fixture();
    await exec("git", ["-C", original, "remote", "set-url", "origin", "https://example.invalid/other.git"]);
    await exec("git", ["-C", original, "config", "--add", "remote.origin.url", input.workspace.repoUrl]);
    await expect(resolvePersistedGitWorkspaceSource(input)).rejects.toMatchObject({ resultJson: { workspaceValidation: {
      reasonCode: "source_repository_mismatch",
    } } });
  });

  it("rejects changed origin identity even at the recorded managed path", async () => {
    const { original, input } = await fixture();
    await exec("git", ["-C", original, "remote", "set-url", "origin", "https://example.invalid/other.git"]);
    await expect(resolvePersistedGitWorkspaceSource(input)).rejects.toMatchObject({ resultJson: { workspaceValidation: {
      reasonCode: "source_repository_mismatch",
    } } });
  });

  it("refuses an independent clone masquerading as the selected linked worktree", async () => {
    const { root, original, input } = await fixture();
    const clone = path.join(root, "clone");
    await exec("git", ["clone", original, clone]);
    await expect(resolvePersistedGitWorkspaceSource({ ...input, workspace: { ...input.workspace, cwd: clone, providerRef: clone },
      candidateBaseCwds: [clone] })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_registration_unproven" } } });
  });

  it("refuses a primary checkout whose separate Git directory impersonates a managed base", async () => {
    const { root, original, input } = await fixture();
    const fakeOwner = path.join(root, "fake-owner");
    const clone = path.join(root, "separate-checkout");
    await fs.mkdir(fakeOwner);
    await exec("git", ["clone", "--separate-git-dir", path.join(fakeOwner, ".git"), original, clone]);
    await exec("git", ["-C", clone, "remote", "set-url", "origin", input.workspace.repoUrl]);
    // This shape can appear in a complete worktree list, but has no per-worktree
    // storage under the owner's .git/worktrees directory.
    await expect(resolvePersistedGitWorkspaceSource({ ...input, workspace: { ...input.workspace, cwd: clone, providerRef: clone },
      candidateBaseCwds: [fakeOwner] })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_registration_unproven" } } });
  });

  it("preserves registered local sources whose configured cwd is a repository subfolder", async () => {
    const { original, input } = await fixture();
    const cwd = path.join(original, "subfolder");
    await fs.mkdir(cwd);
    expect(await resolvePersistedGitWorkspaceSource({ ...input,
      workspace: { ...input.workspace, repoUrl: null, projectWorkspaceId: "bound" }, candidateBaseCwds: [],
      boundProjectWorkspace: { id: "bound", companyId: "company", projectId: "project", cwd },
    })).toBe(original);
  });

  it("supports a bound local repository with separate Git storage", async () => {
    const { root, input } = await fixture();
    const owner = path.join(root, "separate-owner");
    const storage = path.join(root, "git-storage");
    const task = path.join(root, "separate-task");
    await exec("git", ["init", "--separate-git-dir", storage, owner]);
    await exec("git", ["-C", owner, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
    await exec("git", ["-C", owner, "worktree", "add", "-b", "retained", task]);
    expect(await resolvePersistedGitWorkspaceSource({ ...input,
      workspace: { ...input.workspace, repoUrl: null, cwd: task, providerRef: task, projectWorkspaceId: "bound" }, candidateBaseCwds: [],
      boundProjectWorkspace: { id: "bound", companyId: "company", projectId: "project", cwd: owner },
    })).toBe(owner);
  });

  it("does not reconstruct a missing local worktree from its binding's replacement cwd", async () => {
    const { original, replacement, worktree, input } = await fixture();
    await exec("git", ["-C", original, "worktree", "remove", "--force", worktree]);
    await expect(resolvePersistedGitWorkspaceSource({ ...input,
      workspace: { ...input.workspace, repoUrl: null, projectWorkspaceId: "bound" }, candidateBaseCwds: [],
      boundProjectWorkspace: { id: "bound", companyId: "company", projectId: "project", cwd: replacement },
    })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_repository_unavailable" } } });
  });

  it("fails closed when a legacy local source lost its only project association", async () => {
    const { input } = await fixture();
    await expect(resolvePersistedGitWorkspaceSource({ ...input, workspace: { ...input.workspace, repoUrl: null },
      candidateBaseCwds: [] })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_registration_unproven" } } });
  });

  it("rejects a changed bound local cwd instead of adopting its new repository", async () => {
    const { replacement, input } = await fixture();
    await expect(resolvePersistedGitWorkspaceSource({ ...input,
      workspace: { ...input.workspace, repoUrl: null, projectWorkspaceId: "bound" }, candidateBaseCwds: [],
      boundProjectWorkspace: { id: "bound", companyId: "company", projectId: "project", cwd: replacement },
    })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_registration_unproven" } } });
  });

  it("materializes only the recorded original source when both managed checkout and worktree are absent", async () => {
    const { root, original, input } = await fixture();
    const restored = path.join(root, "restored-source");
    const missingWorktree = path.join(root, "missing-worktree");
    const materializeOriginalRepository = vi.fn(async () => {
      await exec("git", ["clone", original, restored]);
      await exec("git", ["-C", restored, "remote", "set-url", "origin", input.workspace.repoUrl]);
      return restored;
    });
    expect(await resolvePersistedGitWorkspaceSource({ ...input,
      workspace: { ...input.workspace, cwd: missingWorktree, providerRef: missingWorktree },
      candidateBaseCwds: [restored], materializeOriginalRepository,
    })).toBe(restored);
    expect(materializeOriginalRepository).toHaveBeenCalledTimes(1);
  });

  it("rejects a materializer result outside the retained source candidates", async () => {
    const { root, original, input } = await fixture();
    const missingWorktree = path.join(root, "missing-worktree");
    await expect(resolvePersistedGitWorkspaceSource({ ...input,
      workspace: { ...input.workspace, cwd: missingWorktree, providerRef: missingWorktree },
      candidateBaseCwds: [], materializeOriginalRepository: async () => original,
    })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_repository_unavailable" } } });
  });

  it("does not invoke materialization through a managed project symlink", async () => {
    const { root, original, input } = await fixture();
    const scoped = path.join(root, "scoped");
    await fs.symlink(original, scoped);
    const missingWorktree = path.join(root, "missing-worktree");
    const materializeOriginalRepository = vi.fn(async () => original);
    await expect(resolvePersistedGitWorkspaceSource({ ...input,
      workspace: { ...input.workspace, cwd: missingWorktree, providerRef: missingWorktree },
      candidateBaseCwds: [path.join(scoped, "new-clone")], materializeOriginalRepository,
    })).rejects.toMatchObject({ resultJson: { workspaceValidation: { reasonCode: "source_repository_unavailable" } } });
    expect(materializeOriginalRepository).not.toHaveBeenCalled();
  });

  it("rebuilds a missing worktree only from the retained source, not a new primary", async () => {
    const { original, replacement, worktree, input } = await fixture();
    await exec("git", ["-C", original, "worktree", "remove", "--force", worktree]);
    expect(await resolvePersistedGitWorkspaceSource({ ...input, candidateBaseCwds: [replacement, original] })).toBe(original);
    await expect(resolvePersistedGitWorkspaceSource({ ...input, candidateBaseCwds: [replacement] })).rejects.toMatchObject({
      resultJson: { workspaceValidation: { reasonCode: "source_repository_unavailable" } },
    });
  });
});
