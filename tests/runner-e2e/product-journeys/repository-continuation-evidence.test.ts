import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repositoryContinuationSource, repositoryContinuationStory } from "./repository-continuation-contract.js";
import { inspectRepositoryBundle, repositoryCommitMatches, repositoryWorkspaceBindingMatches, repositoryWorkspaceFileMatches,
  type RepositoryBundleEvidence } from "./repository-continuation-evidence.js";
import type { WorkspaceFileContent } from "../../../packages/shared/src/types/workspace-file-resource.js";

const execFile = promisify(execFileCallback);
describe("repository continuation Git evidence", () => {
  let root: string, sourceCommit: string, first: RepositoryBundleEvidence, final: RepositoryBundleEvidence, firstBytes: Buffer;
  const reference = `${"c".repeat(64)}\n`, firstFile = "first.txt", contextFile = "context.txt", finalFile = "followup.txt";
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-qa-repo-control-"));
    const git = async (...args: string[]) => (await execFile("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
      encoding: "utf8", timeout: 10_000,
    })).stdout;
    await git("init");
    await writeFile(path.join(root, "README"), repositoryContinuationSource.readme);
    await git("add", "README"); await git("commit", "-m", "source");
    sourceCommit = (await git("rev-parse", "HEAD")).trim();
    await writeFile(path.join(root, contextFile), reference); await writeFile(path.join(root, firstFile), "first\n");
    await git("add", contextFile, firstFile); await git("commit", "-m", "first");
    await git("bundle", "create", path.join(root, "first.bundle"), "HEAD");
    firstBytes = await readFile(path.join(root, "first.bundle"));
    first = await inspectRepositoryBundle(firstBytes, { sourceCommit, files: [contextFile, firstFile, "README"] });
    await writeFile(path.join(root, finalFile), "verified\n"); await git("add", finalFile); await git("commit", "-m", "second");
    await git("bundle", "create", "--version=3", path.join(root, "final.bundle"), "HEAD");
    final = await inspectRepositoryBundle(await readFile(path.join(root, "final.bundle")), { sourceCommit, files: [contextFile, firstFile, finalFile, "README"] });
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const expectedFirst = () => ({ parent: sourceCommit, sourceReadme: repositoryContinuationSource.readme,
    files: { [contextFile]: reference, [firstFile]: "first\n", README: repositoryContinuationSource.readme }, added: [contextFile, firstFile] });
  it("reads real Git commits, parent links and file objects from both downloaded bundles", () => {
    expect(repositoryCommitMatches(first, expectedFirst())).toBe(true);
    expect(repositoryCommitMatches(final, { parent: first.head, sourceReadme: repositoryContinuationSource.readme,
      files: { [contextFile]: reference, [firstFile]: "first\n", [finalFile]: "verified\n", README: repositoryContinuationSource.readme }, added: [finalFile] })).toBe(true);
  });
  const invalidEvidence: Array<[string, () => RepositoryBundleEvidence | null]> = [
    ["missing", () => null],
    ["rewritten history", () => ({ ...first, parent: "a".repeat(40) })],
    ["no new commit", () => ({ ...first, head: sourceCommit })],
    ["wrong repository", () => ({ ...first, sourceReadme: "Other repository\n" })],
    ["original changed", () => ({ ...first, files: { ...first.files, [contextFile]: "replacement\n" } })],
    ["extra changes", () => ({ ...first, changes: [...first.changes, { status: "M", path: "README" }] })],
    ["missing saved file", () => ({ ...first, files: {} })],
    ["duplicate tree path", () => ({ ...first, changes: [first.changes[0]!, first.changes[0]!] })],
    ["modified original", () => ({ ...first, changes: first.changes.map(change => ({ ...change, status: "M" })) })],
  ];
  it.each(invalidEvidence)("rejects %s evidence", (_name, change) => { expect(repositoryCommitMatches(change(), expectedFirst())).toBe(false); });
  it("rejects malformed, corrupt, incomplete and unrelated Git bundles", async () => {
    await expect(inspectRepositoryBundle(Buffer.from("claimed git commit"), { sourceCommit, files: [] })).rejects.toThrow();
    await expect(inspectRepositoryBundle(firstBytes.subarray(0, 150), { sourceCommit, files: [] })).rejects.toThrow();
    await expect(inspectRepositoryBundle(firstBytes, { sourceCommit: "f".repeat(40), files: [] })).rejects.toThrow();
    await expect(inspectRepositoryBundle(firstBytes, { sourceCommit, files: ["../escape"] })).rejects.toThrow();
  });
});

describe("repository continuation target binding", () => {
  const issue = { id: "issue", companyId: "company", projectId: "project", executionWorkspaceId: "workspace" };
  const run = { companyId: "company", runnerProfileJson: { nativeExecutionInput: { binding: { executionWorkspaceId: "workspace" } } } };
  const workspace = { id: "workspace", companyId: "company", projectId: "project", projectWorkspaceId: "project-workspace", repoUrl: repositoryContinuationSource.url };
  const input = { companyId: "company", issueId: "issue", projectId: "project", projectWorkspaceId: "project-workspace", workspaceId: "workspace",
    repoUrl: repositoryContinuationSource.url, issue, view: { issueId: "issue", workspace }, runs: [run] };
  it("requires the configured project, actual task workspace and every run binding", () => {
    expect(repositoryWorkspaceBindingMatches(input)).toBe(true);
    expect(repositoryWorkspaceBindingMatches({ ...input, runs: [] })).toBe(false);
    expect(repositoryWorkspaceBindingMatches({ ...input, view: {} })).toBe(false);
    for (const change of [{ id: "foreign" }, { companyId: "foreign" }, { projectId: "foreign" },
      { projectWorkspaceId: "foreign" }, { repoUrl: "https://example.test/other" }]) {
      expect(repositoryWorkspaceBindingMatches({ ...input, view: { ...input.view, workspace: { ...workspace, ...change } } })).toBe(false);
    }
    expect(repositoryWorkspaceBindingMatches({ ...input, runs: [run, { ...run, companyId: "foreign" }] })).toBe(false);
    expect(repositoryWorkspaceBindingMatches({ ...input, runs: [run, { companyId: "company" }] })).toBe(false);
    expect(repositoryWorkspaceBindingMatches({ ...input, issue: { ...issue, executionWorkspaceId: "replacement" } })).toBe(false);
  });
  it("compares exact workspace API bytes and rejects another workspace or file", () => {
    const file = { resource: { kind: "file", workspaceKind: "execution_workspace", workspaceId: "workspace", title: "context.txt", byteSize: 4 },
      content: { encoding: "utf8", data: "abc\n" } } as WorkspaceFileContent;
    expect(repositoryWorkspaceFileMatches(file, "workspace", "context.txt", "abc\n")).toBe(true);
    expect(repositoryWorkspaceFileMatches(null, "workspace", "context.txt", "abc\n")).toBe(false);
    expect(repositoryWorkspaceFileMatches(file, "foreign", "context.txt", "abc\n")).toBe(false);
    expect(repositoryWorkspaceFileMatches(file, "workspace", "wrong.txt", "abc\n")).toBe(false);
    expect(repositoryWorkspaceFileMatches(file, "workspace", "context.txt", "xyz\n")).toBe(false);
  });
  it("keeps the later user request free from the unpredictable earlier reference", () => {
    const story = repositoryContinuationStory("journey-1793642415731-3c34246f");
    expect(story.first).toContain(repositoryContinuationSource.commit);
    expect(story.followup).toContain("Never recreate");
    expect(story.followup).not.toContain("c".repeat(64));
    expect(() => repositoryContinuationStory("../unsafe")).toThrow();
  });
  it("emits unambiguous LF instructions for the independently verified file bytes", () => {
    const story = repositoryContinuationStory("journey-1793642415731-3c34246f");
    expect(story.first).toContain("containing only the text first followed by exactly one LF newline.");
    expect(story.followup).toContain("containing only the text verified followed by exactly one LF newline.");
    expect(story.first).not.toContain("first\\n");
    expect(story.followup).not.toContain("verified\\n");
  });
});
