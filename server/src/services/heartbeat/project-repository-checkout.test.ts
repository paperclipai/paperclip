import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareProjectRepositoryWorkspaces } from "./workspaces.js";
import { readRequestedProjectRepositoryIds } from "../project-repository-requests.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("project repository checkout scope", () => {
  let root: string;
  let taskCwd: string;
  let workspaces: Array<{ id: string; repoUrl: string; repoRef: string }>;

  async function remote(name: string) {
    const author = path.join(root, `${name}-author`);
    const bare = path.join(root, `${name}.git`);
    await fs.mkdir(author);
    git(author, "init", "--initial-branch=main");
    git(author, "config", "user.email", "test@example.com");
    git(author, "config", "user.name", "Test");
    await fs.writeFile(path.join(author, `${name}.txt`), `${name}\n`);
    git(author, "add", ".");
    git(author, "commit", "-m", name);
    git(root, "clone", "--bare", author, bare);
    return pathToFileURL(bare).href;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "project-repository-checkout-"));
    taskCwd = path.join(root, "task");
    await fs.mkdir(taskCwd);
    git(taskCwd, "init", "--initial-branch=main");
    workspaces = [
      { id: randomUUID(), repoUrl: await remote("api"), repoRef: "main" },
      { id: randomUUID(), repoUrl: await remote("web"), repoRef: "main" },
    ];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const prepare = (input: { repositoryCheckout?: "all" | "primary"; keepWorkspaceIds?: string[] } = {}) =>
    prepareProjectRepositoryWorkspaces({ cwd: taskCwd, anchorRepoUrl: null, workspaces, resolveGitAuth: async () => null, ...input });

  it("checks out every project repository by default", async () => {
    const prepared = await prepare();
    expect(prepared.map(repo => repo.workspaceId)).toEqual(workspaces.map(workspace => workspace.id));
  });

  it("checks out no extra repository for a new task when the project checks out its primary repository only", async () => {
    expect(await prepare({ repositoryCheckout: "primary" })).toEqual([]);
  });

  it("checks out a requested repository and keeps it on later admissions", async () => {
    const [requested] = await prepare({ repositoryCheckout: "primary", keepWorkspaceIds: [workspaces[1]!.id] });
    expect(requested).toMatchObject({ workspaceId: workspaces[1]!.id });
    expect(await fs.readFile(path.join(requested!.cwd, "web.txt"), "utf8")).toBe("web\n");
    expect((await prepare({ repositoryCheckout: "primary" })).map(repo => repo.workspaceId)).toEqual([workspaces[1]!.id]);
  });

  it("keeps the checkouts a task already has when the project switches to its primary repository only", async () => {
    await prepare();
    expect((await prepare({ repositoryCheckout: "primary" })).map(repo => repo.workspaceId))
      .toEqual(workspaces.map(workspace => workspace.id));
  });
});

describe("readRequestedProjectRepositoryIds", () => {
  it("reads only string ids from workspace metadata", () => {
    expect(readRequestedProjectRepositoryIds({ requestedProjectRepositoryIds: ["a", 2, "b"] })).toEqual(["a", "b"]);
    expect(readRequestedProjectRepositoryIds(null)).toEqual([]);
    expect(readRequestedProjectRepositoryIds({ requestedProjectRepositoryIds: "a" })).toEqual([]);
  });
});
