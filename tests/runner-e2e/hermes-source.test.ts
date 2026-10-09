import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devNull, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHermesQualificationSource } from "./hermes-source.js";
import { resolveRunnerE2ESource } from "./source.js";
import type { MatrixExecution } from "./types.js";

const selected = [{ profile: { qualificationCandidate: "hermes" } }] as MatrixExecution[];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function checkout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hermes-source-test-"))); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-b", "qualification");
  writeFileSync(join(root, "source.txt"), "original\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "original lock\n");
  git("add", "source.txt", "pnpm-lock.yaml");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${devNull}`, "commit", "-m", "fixture");
  return { root, git, sha: git("rev-parse", "HEAD") };
}

describe("Hermes qualification controller source admission", () => {
  it("records the real checkout automatically in child/result provenance instead of a workflow SHA", () => {
    const f = checkout(); const env = { PATH: process.env.PATH, GITHUB_SHA: "b".repeat(40), GITHUB_REF: "refs/heads/master" };
    expect(prepareHermesQualificationSource(selected, f.root, env)).toMatchObject({ sha: f.sha, ref: "refs/heads/qualification", workingTreeClean: true });
    expect(resolveRunnerE2ESource(null, env)).toMatchObject({ sha: f.sha, ref: "refs/heads/qualification" });
  });
  it("preserves a requested target ref only after independently matching its SHA", () => {
    const f = checkout(); const env = { PATH: process.env.PATH, PAPERCLIP_RUNNER_E2E_SOURCE_SHA: f.sha, PAPERCLIP_RUNNER_E2E_SOURCE_REF: "refs/pull/123/merge" };
    expect(prepareHermesQualificationSource(selected, f.root, env)).toMatchObject({ sha: f.sha, ref: "refs/pull/123/merge" });
    expect(() => prepareHermesQualificationSource(selected, f.root, { ...env, PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "a".repeat(40) })).toThrow("differs");
  });
  it("records detached HEAD instead of borrowing another workflow ref", () => {
    const f = checkout(); f.git("checkout", "--detach", f.sha);
    const env = { PATH: process.env.PATH, GITHUB_REF: "refs/heads/master" };
    expect(prepareHermesQualificationSource(selected, f.root, env)).toMatchObject({ sha: f.sha, ref: "HEAD" });
  });
  it.each(["tracked", "untracked"])("rejects %s source changes without returning a source receipt", kind => {
    const f = checkout(); writeFileSync(join(f.root, kind === "tracked" ? "source.txt" : "extra.txt"), "changed\n");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    expect(() => prepareHermesQualificationSource(selected, f.root, env)).toThrow("clean checkout before credentials");
    expect(env.PAPERCLIP_RUNNER_E2E_SOURCE_SHA).toBeUndefined();
  });
  it("does not run Git or alter provenance for other providers or missing selections", () => {
    const env = { PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "existing" };
    expect(prepareHermesQualificationSource([], "/does-not-exist", env)).toBeNull();
    expect(prepareHermesQualificationSource([{ profile: { qualificationCandidate: "cursor" } }] as MatrixExecution[], "/does-not-exist", env)).toBeNull();
    expect(env).toEqual({ PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "existing" });
  });
  it("ignores ambient Git redirection and keeps credentials out of the source receipt", () => {
    const f = checkout();
    const env = { PATH: process.env.PATH, GIT_DIR: "/does-not-exist", GIT_WORK_TREE: "/does-not-exist",
      OPENROUTER_API_KEY: "fixture-private-token", FUTURE_PROVIDER_API_KEY: "fixture-private-token" };
    const receipt = prepareHermesQualificationSource(selected, f.root, env);
    expect(receipt).toMatchObject({ sha: f.sha });
    expect(JSON.stringify(receipt)).not.toContain("fixture-private-token");
  });
  it("rejects unreadable source without accepting an operator-supplied SHA", () => {
    const env = { PATH: process.env.PATH, PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "a".repeat(40) };
    expect(() => prepareHermesQualificationSource(selected, "/does-not-exist", env)).toThrow("readable Git source before credentials");
  });
});

describe("approved qualification dependency lock", () => {
  const resolved = "reviewed resolved lock\n";
  const digest = createHash("sha256").update(resolved).digest("hex");
  it("admits only the independently verified lock replacement and records its digest and dirty state", () => {
    const f = checkout(); writeFileSync(join(f.root, "pnpm-lock.yaml"), resolved);
    const env = { PATH: process.env.PATH, PAPERCLIP_RUNNER_E2E_LOCK_SHA256: digest };
    expect(prepareHermesQualificationSource(selected, f.root, env)).toMatchObject({
      sha: f.sha, workingTreeClean: false, approvedLockSha256: digest,
    });
    expect(resolveRunnerE2ESource(null, env).sha).toBe(f.sha);
  });
  it("still records a verified lock when it already matches the commit", () => {
    const f = checkout();
    const originalDigest = createHash("sha256").update("original lock\n").digest("hex");
    expect(prepareHermesQualificationSource(selected, f.root, {
      PATH: process.env.PATH, PAPERCLIP_RUNNER_E2E_LOCK_SHA256: originalDigest,
    })).toMatchObject({ workingTreeClean: true, approvedLockSha256: originalDigest });
  });
  it.each(["missing", "incorrect", "malformed"])("rejects a replacement with %s approval before recording source", approval => {
    const f = checkout(); writeFileSync(join(f.root, "pnpm-lock.yaml"), resolved);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH,
      ...(approval === "missing" ? {} : { PAPERCLIP_RUNNER_E2E_LOCK_SHA256: approval === "incorrect" ? "a".repeat(64) : "not-a-digest" }) };
    expect(() => prepareHermesQualificationSource(selected, f.root, env)).toThrow();
    expect(env.PAPERCLIP_RUNNER_E2E_SOURCE_SHA).toBeUndefined();
  });
  it.each(["source", "untracked", "staged", "deleted", "symlink"])("rejects %s changes even alongside an approved digest", kind => {
    const f = checkout(); const lock = join(f.root, "pnpm-lock.yaml"); writeFileSync(lock, resolved);
    if (kind === "source") writeFileSync(join(f.root, "source.txt"), "changed\n");
    if (kind === "untracked") writeFileSync(join(f.root, "extra.txt"), "changed\n");
    if (kind === "staged") f.git("add", "pnpm-lock.yaml");
    if (kind === "deleted" || kind === "symlink") rmSync(lock);
    if (kind === "symlink") { writeFileSync(join(f.root, "resolved.txt"), resolved); symlinkSync("resolved.txt", lock); }
    expect(() => prepareHermesQualificationSource(selected, f.root, {
      PATH: process.env.PATH, PAPERCLIP_RUNNER_E2E_LOCK_SHA256: digest,
    })).toThrow();
  });
});

describe("generated runtime source admission", () => {
  const assetRoot = "packages/paperclip-runner/provider-assets/hermes/linux-x64";
  function generated(root: string, relative: string) {
    const directory = join(root, relative); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "manifest.json"), "fixture runtime bytes\n");
  }
  it("admits untracked Mac/Linux runtime assets and a verified pack without hiding source changes", () => {
    const f = checkout();
    for (const root of [assetRoot, "packages/paperclip-runner/provider-assets/hermes/darwin-arm64", "packages/paperclip-runner/provider-pack"]) generated(f.root, root);
    expect(prepareHermesQualificationSource(selected, f.root, { PATH: process.env.PATH })).toMatchObject({ sha: f.sha, workingTreeClean: true });
    writeFileSync(join(f.root, "source.txt"), "changed source\n");
    expect(() => prepareHermesQualificationSource(selected, f.root, { PATH: process.env.PATH })).toThrow("clean checkout before credentials");
  });
  it.each(["runner-e2e-build", "runner-e2e-provider-pack", "packages/paperclip-runner/provider-assets/hermes/win32-x64", "packages/paperclip-runner/provider-assets/unmanaged"])("rejects untracked files in %s", root => {
    const f = checkout(); generated(f.root, assetRoot); generated(f.root, root);
    expect(() => prepareHermesQualificationSource(selected, f.root, { PATH: process.env.PATH })).toThrow("clean checkout before credentials");
  });
  it.each(["modified", "staged", "deleted"])("rejects %s tracked files inside a generated asset root", kind => {
    const f = checkout(); generated(f.root, assetRoot); f.git("add", assetRoot);
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${devNull}`, "commit", "-m", "tracked asset fixture");
    const file = join(f.root, assetRoot, "manifest.json");
    if (kind === "deleted") rmSync(file); else writeFileSync(file, "changed tracked asset\n");
    if (kind === "staged") f.git("add", assetRoot);
    expect(() => prepareHermesQualificationSource(selected, f.root, { PATH: process.env.PATH })).toThrow("clean checkout before credentials");
  });
  it("rejects a runtime-root symlink instead of treating it as generated content", () => {
    const f = checkout(); const parent = join(f.root, "packages/paperclip-runner/provider-assets/hermes"); mkdirSync(parent, { recursive: true });
    symlinkSync(f.root, join(parent, "linux-x64"));
    expect(() => prepareHermesQualificationSource(selected, f.root, { PATH: process.env.PATH })).toThrow("clean checkout before credentials");
  });
});
