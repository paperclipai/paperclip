import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTarballFromDirectory } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { stageRemoteLaunchAssets } from "./remote-launch-assets.js";
import { prepareIsolatedCodexHome, releaseMaterializedNativeRuntimeSkills, resolveRunnerdCodexSkillInputs } from "../../vendor/paperclip-runner/testing.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const roots: string[] = [];
afterEach(() => {
  function writable(path: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) writable(join(path, entry));
    }
  }
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture(options: { transport?: "sandbox" | "ssh"; concurrent?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "native-launch-assets-"));
  roots.push(root);
  mkdirSync(join(root, "codex-home"));
  writeFileSync(join(root, "codex-home", "auth.json"), "fresh test auth");
  writeFileSync(join(root, "codex-home", "config.toml"), "fresh test config");
  const calls: string[] = [];
  const source = nativeRuntimeContextFixture();
  const target = nativeRuntimeContextFixture();
  source.instructions.bundle.rootPath = join(root, "instructions");
  target.instructions.bundle.rootPath = "/session/filesystem/context/instructions";
  source.skills = [{ key: "test", runtimeName: "test", versionId: null, bundle: { ...source.instructions.bundle, rootPath: join(root, "skill") } }] as typeof source.skills;
  target.skills = [{ ...source.skills[0]!, bundle: { ...source.skills[0]!.bundle, rootPath: "/session/filesystem/context/skills/0-digest" } }];
  const stageFile = vi.fn(async (input: { sourcePath: string; targetPath: string; mode: number }) => {
    calls.push(`file:${input.targetPath}`);
  });
  const stageDirectory = vi.fn(async (input: { sourcePath: string; targetPath: string; mode: number }) => {
    calls.push(`directory:${input.targetPath}`);
  });
  const execute = vi.fn(async (_input: { command: string; args?: string[]; bypassSession?: boolean; timeoutMs?: number }) => {
    calls.push("mkdir:codex-home");
    return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stdout: "", stderr: "" };
  });
  const input: Parameters<typeof stageRemoteLaunchAssets>[0] = {
    root,
    transport: options.transport ?? "sandbox",
    runner: { execute, allowConcurrentSyncOperations: options.concurrent },
    persistenceDirectories: [{ name: "codex-home", location: "filesystem", targetPath: "/session/filesystem/codex-home" }],
    runtimeContext: { source, target, filesystemRoot: "/session/filesystem" },
    caBundleMapping: { sourcePath: join(root, "ca.pem"), targetPath: "/session/bin/ca.pem" },
    stageFile,
    stageDirectory,
  };
  return { input, root, calls, stageFile, stageDirectory, execute };
}

async function filesystemFixture() {
  const f = fixture();
  const source = f.input.runtimeContext!.source;
  f.input.isolatedCodexSkills = { workspaceRoot: f.root };
  mkdirSync(source.instructions.bundle.rootPath);
  writeFileSync(join(source.instructions.bundle.rootPath, "AGENTS.md"), "Agent instructions\n");
  mkdirSync(source.skills[0]!.bundle.rootPath);
  writeFileSync(join(source.skills[0]!.bundle.rootPath, "SKILL.md"), "---\nname: test\ndescription: Selected skill\n---\nUse a native confirmation.\n");
  mkdirSync(join(source.skills[0]!.bundle.rootPath, "scripts"));
  writeFileSync(join(source.skills[0]!.bundle.rootPath, "scripts", "selected.sh"), "#!/bin/sh\nprintf selected\\n\n", { mode: 0o755 });
  await prepareIsolatedCodexHome({ context: source, codexHome: join(f.root, "codex-home") });
  const remote = join(f.root, "remote", "codex-home");
  f.input.persistenceDirectories = [{ name: "codex-home", location: "filesystem", targetPath: remote }];
  f.input.stageFile = async ({ sourcePath, targetPath }) => {
    if (!targetPath.startsWith(f.root)) return;
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath);
  };
  f.input.stageDirectory = vi.fn(async ({ sourcePath, targetPath }) => {
    if (!targetPath.startsWith(f.root)) return;
    // Native sandbox transfer archives omit the source root and mkdir the
    // destination without applying the mapping mode. Exercise those actual
    // tar/filesystem semantics rather than forcing the requested mode here.
    const archivePath = join(f.root, "native-transfer.tar");
    await createTarballFromDirectory({ localDir: sourcePath, archivePath });
    execFileSync("sh", ["-c", 'umask 022; mkdir -p "$1" && tar -xf "$2" -C "$1"', "native-directory-transfer", targetPath, archivePath]);
  });
  f.input.runner.execute = async ({ command, args }) => {
    try {
      const stdout = execFileSync(command, args, { encoding: "utf8", stdio: "pipe" });
      return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stdout: stdout.toString(), stderr: "" };
    } catch {
      return { exitCode: 1, signal: null, pid: null, startedAt: null, timedOut: false, stdout: "", stderr: "fixture command rejected" };
    }
  };
  return { ...f, source, remote };
}

describe("remote launch asset staging", () => {
  it("delivers the selected Codex skills to the same discoverable path used by explicit turn input", async () => {
    const f = await filesystemFixture();
    await stageRemoteLaunchAssets(f.input);
    const [skill] = resolveRunnerdCodexSkillInputs([
      { type: "skill", name: "test", path: join(f.source.skills[0]!.bundle.rootPath, "SKILL.md") },
    ], f.source, f.remote);
    expect(existsSync(skill!.path)).toBe(true);
    expect(readFileSync(skill!.path, "utf8")).toContain("Use a native confirmation.");
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    for (const relative of ["SKILL.md", "scripts/selected.sh"]) {
      expect(digest(join(f.remote, "skills", "test", relative))).toBe(digest(join(f.root, "codex-home", "skills", "test", relative)));
    }
    expect(statSync(skill!.path).mode & 0o777).toBe(0o444);
    expect(statSync(join(f.remote, "skills", "test")).mode & 0o222).toBe(0);
    expect(statSync(join(f.remote, "skills", "test", "scripts", "selected.sh")).mode & 0o777).toBe(0o555);
    expect(statSync(join(f.remote, "skills")).mode & 0o777).toBe(0o700);
  });

  it("replaces stale and revoked skills on resume while retaining provider history", async () => {
    const f = await filesystemFixture();
    await stageRemoteLaunchAssets(f.input);
    writeFileSync(join(f.remote, "conversation.json"), "saved provider conversation");
    mkdirSync(join(f.remote, "skills", "ambient"));
    writeFileSync(join(f.remote, "skills", "ambient", "SKILL.md"), "unassigned");
    await releaseMaterializedNativeRuntimeSkills(join(f.root, "codex-home", "skills"));
    f.source.skills = [];
    f.input.runtimeContext!.target.skills = [];
    await prepareIsolatedCodexHome({ context: f.source, codexHome: join(f.root, "codex-home") });
    await stageRemoteLaunchAssets(f.input);
    expect(readdirSync(join(f.remote, "skills"))).toEqual([]);
    expect(readFileSync(join(f.remote, "conversation.json"), "utf8")).toBe("saved provider conversation");
  });

  it("delivers flat and nested selected packages without flattening their paths", async () => {
    const f = await filesystemFixture();
    const nestedRoot = join(f.root, "nested-skill");
    mkdirSync(nestedRoot);
    const body = "---\nname: nested\ndescription: Nested selected skill\n---\nKeep the nested package.\n";
    writeFileSync(join(nestedRoot, "SKILL.md"), body);
    f.source.skills.push({ ...f.source.skills[0]!, key: "nested", runtimeName: "group/nested",
      bundle: { ...f.source.skills[0]!.bundle, rootPath: nestedRoot } });
    f.input.runtimeContext!.target.skills = f.source.skills.map((skill, index) => ({ ...skill,
      bundle: { ...skill.bundle, rootPath: `/session/filesystem/context/skills/${index}-digest` } }));
    await releaseMaterializedNativeRuntimeSkills(join(f.root, "codex-home", "skills"));
    await prepareIsolatedCodexHome({ context: f.source, codexHome: join(f.root, "codex-home") });
    await stageRemoteLaunchAssets(f.input);
    expect(readFileSync(join(f.remote, "skills", "test", "SKILL.md"), "utf8")).toContain("Use a native confirmation.");
    expect(readFileSync(join(f.remote, "skills", "group", "nested", "SKILL.md"), "utf8")).toBe(body);
    expect(statSync(join(f.remote, "skills", "group", "nested", "SKILL.md")).mode & 0o222).toBe(0);
  });

  it.each(["symlink", "ambient", "writable"] as const)("rejects an unsafe selected source projection before clearing retained skills: %s", async kind => {
    const f = await filesystemFixture();
    mkdirSync(join(f.remote, "skills"), { recursive: true });
    writeFileSync(join(f.remote, "skills", "retained"), "not touched before valid admission");
    const home = join(f.root, "codex-home", "skills");
    if (kind === "ambient") {
      mkdirSync(join(home, "unassigned"));
      writeFileSync(join(home, "unassigned", "SKILL.md"), "unassigned", { mode: 0o444 });
    } else if (kind === "writable") chmodSync(join(home, "test", "SKILL.md"), 0o644);
    else {
      chmodSync(join(home, "test"), 0o700);
      symlinkSync(join(f.root, "outside"), join(home, "test", "link"));
    }
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("runner_remote_codex_skills_invalid");
    expect(readFileSync(join(f.remote, "skills", "retained"), "utf8")).toBe("not touched before valid admission");
  });

  it.each([false, true])("rejects a retained skills-root symlink without touching its target (dangling: %s)", async dangling => {
    const f = await filesystemFixture();
    mkdirSync(f.remote, { recursive: true });
    const outside = join(f.root, "outside");
    if (!dangling) { mkdirSync(outside); writeFileSync(join(outside, "keep"), "untouched"); }
    symlinkSync(outside, join(f.remote, "skills"));
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("runner_remote_codex_skills_reset_failed");
    expect(lstatSync(join(f.remote, "skills")).isSymbolicLink()).toBe(true);
    if (!dangling) expect(readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
  });

  it.each(["sandbox", "ssh"] as const)("rejects a redirected retained ancestor before writing launch assets: %s", async transport => {
    const f = await filesystemFixture();
    f.input.transport = transport;
    const outside = join(f.root, "outside");
    mkdirSync(join(outside, "codex-home", "skills"), { recursive: true });
    writeFileSync(join(outside, "codex-home", "skills", "keep"), "untouched");
    symlinkSync(outside, join(f.root, "retained-filesystem"));
    f.input.persistenceDirectories = [{ name: "codex-home", location: "filesystem", targetPath: join(f.root, "retained-filesystem", "codex-home") }];
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("runner_remote_codex_skills_reset_failed");
    expect(readFileSync(join(outside, "codex-home", "skills", "keep"), "utf8")).toBe("untouched");
    expect(existsSync(join(outside, "codex-home", "config.toml"))).toBe(false);
  });

  it("allows an explicitly authorized workspace alias while checking its owned descendants", async () => {
    const f = await filesystemFixture();
    const actual = join(f.root, "authorized-workspace");
    mkdirSync(actual);
    const alias = join(f.root, "authorized-alias");
    symlinkSync(actual, alias);
    f.input.isolatedCodexSkills = { workspaceRoot: alias };
    f.input.persistenceDirectories = [{ name: "codex-home", location: "filesystem", targetPath: join(alias, "codex-home") }];
    await stageRemoteLaunchAssets(f.input);
    expect(readFileSync(join(actual, "codex-home", "skills", "test", "SKILL.md"), "utf8")).toContain("Use a native confirmation.");
  });

  it("does not project skills for a preconfigured home or another provider", async () => {
    const f = await filesystemFixture();
    f.input.isolatedCodexSkills = undefined;
    await stageRemoteLaunchAssets(f.input);
    expect(existsSync(join(f.remote, "skills"))).toBe(false);
  });

  it("retains serial paths, private launch modes and immutable context modes without an opt-in", async () => {
    const f = fixture();
    await stageRemoteLaunchAssets(f.input);
    expect(f.calls).toEqual([
      "mkdir:codex-home",
      "file:/session/filesystem/codex-home/auth.json",
      "file:/session/filesystem/codex-home/config.toml",
      "directory:/session/filesystem/context/instructions",
      "directory:/session/filesystem/context/skills/0-digest",
      "file:/session/filesystem/runtime-context.json",
      "file:/session/bin/ca.pem",
    ]);
    expect(f.stageFile.mock.calls.map(([input]) => input.mode)).toEqual([0o600, 0o600, 0o600, 0o600]);
    expect(f.stageDirectory.mock.calls.map(([input]) => input.mode)).toEqual([0o555, 0o555]);
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({ bypassSession: true, timeoutMs: 10_000 });
    expect(f.execute.mock.calls[0]?.[0]?.args?.[1]).toContain("install -d -m 0700");
    expect(readFileSync(f.stageFile.mock.calls[0]![0].sourcePath, "utf8")).toBe("fresh test auth");
  });

  it("stops serial staging before context and CA writes when launch material fails", async () => {
    const f = fixture();
    f.stageFile.mockRejectedValueOnce(new Error("launch failure"));
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("launch failure");
    expect(f.stageDirectory).not.toHaveBeenCalled();
    expect(f.stageFile).toHaveBeenCalledTimes(1);
  });

  it("fails closed before any transfer when the persistence path is unavailable", async () => {
    const f = fixture();
    f.input.persistenceDirectories = [{ name: "codex-home", location: "filesystem", targetPath: null }];
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("bootstrap_target_unavailable");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.stageDirectory).not.toHaveBeenCalled();
  });

  it("stops before CA staging when the immutable context fails", async () => {
    const f = fixture();
    f.stageDirectory.mockRejectedValueOnce(new Error("context failure"));
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("context failure");
    expect(f.stageFile.mock.calls.map(([input]) => input.targetPath)).toEqual([
      "/session/filesystem/codex-home/auth.json", "/session/filesystem/codex-home/config.toml",
    ]);
  });

  it("does not require a context or launch credential files for preconfigured homes", async () => {
    const f = fixture();
    f.input.persistenceDirectories = [];
    f.input.runtimeContext = null;
    f.input.caBundleMapping = null;
    await stageRemoteLaunchAssets(f.input);
    expect(f.calls).toEqual([]);
  });

  it("overlaps disjoint launch material and context only with verified sandbox concurrency", async () => {
    const f = fixture({ concurrent: true });
    const started = deferred(), release = deferred();
    f.stageFile.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const pending = stageRemoteLaunchAssets(f.input);
    await started.promise;
    try {
      expect(f.stageDirectory).toHaveBeenCalled();
      expect(f.stageFile.mock.calls.some(([input]) => input.targetPath === "/session/bin/ca.pem")).toBe(false);
    } finally { release.resolve(); await pending; }
    expect(f.calls.at(-1)).toBe("file:/session/bin/ca.pem");
  });

  it.each([
    { transport: "ssh" as const, concurrent: true },
    { transport: "sandbox" as const, concurrent: false },
    { transport: "sandbox" as const },
  ])("keeps unsupported transports serial: %j", async (options) => {
    const f = fixture(options);
    const started = deferred(), release = deferred();
    f.stageFile.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const pending = stageRemoteLaunchAssets(f.input);
    await started.promise;
    try { expect(f.stageDirectory).not.toHaveBeenCalled(); }
    finally { release.resolve(); await pending; }
    expect(f.stageDirectory).toHaveBeenCalledTimes(2);
  });

  it("settles the context transfer before exposing a launch-material failure", async () => {
    const f = fixture({ concurrent: true });
    const contextStarted = deferred(), releaseContext = deferred();
    const failure = new Error("launch failed first");
    f.stageFile.mockRejectedValueOnce(failure);
    f.stageDirectory.mockImplementationOnce(async () => { contextStarted.resolve(); await releaseContext.promise; });
    let settled = false;
    let observed: unknown;
    const pending = stageRemoteLaunchAssets(f.input).then(() => { settled = true; }, error => { settled = true; observed = error; });
    await contextStarted.promise;
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { releaseContext.resolve(); await pending; }
    expect(observed).toBe(failure);
    expect(f.stageFile.mock.calls.some(([input]) => input.targetPath === "/session/bin/ca.pem")).toBe(false);
  });

  it("settles launch material before exposing a context failure", async () => {
    const f = fixture({ concurrent: true });
    const launchStarted = deferred(), releaseLaunch = deferred();
    const failure = new Error("context failed first");
    f.stageFile.mockImplementationOnce(async () => { launchStarted.resolve(); await releaseLaunch.promise; });
    f.stageDirectory.mockRejectedValueOnce(failure);
    let settled = false;
    let observed: unknown;
    const pending = stageRemoteLaunchAssets(f.input).then(() => { settled = true; }, error => { settled = true; observed = error; });
    await launchStarted.promise;
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { releaseLaunch.resolve(); await pending; }
    expect(observed).toBe(failure);
    expect(f.stageFile.mock.calls.some(([input]) => input.targetPath === "/session/bin/ca.pem")).toBe(false);
  });

  it("retains launch-material error priority when both parallel transfers fail", async () => {
    const f = fixture({ concurrent: true });
    const failure = new Error("launch priority");
    f.stageFile.mockRejectedValueOnce(failure);
    f.stageDirectory.mockRejectedValueOnce(new Error("context failure"));
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toBe(failure);
    expect(f.stageDirectory).toHaveBeenCalledOnce();
  });
});
