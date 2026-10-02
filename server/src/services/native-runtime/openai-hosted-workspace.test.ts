import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline, serializeDirectorySnapshot, type LegacySerializedDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { finalizeOpenAiHostedWorkspace, materializeOpenAiWorkspace, openAiWorkspaceRelativePath, prepareOpenAiHostedWorkspace } from "./openai-hosted-workspace.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const payload = (entries: unknown[]) => Buffer.from(JSON.stringify({ schema: "paperclip.openai-workspace-export.v1", entries }));
const empty: LegacySerializedDirectorySnapshot = { version: 1, exclude: [], entries: [] };
async function root() { const result = await mkdtemp(path.join(tmpdir(), "openai-workspace-test-")); dirs.push(result); return result; }
describe("OpenAI hosted workspace return", () => {
  it("rejects traversal, Git metadata, control files, duplicate paths, and symlink parents", async () => {
    for (const value of ["../outside", "/tmp/outside", ".git/config", "repo/.git/config", "a\\b", "a/./b", ".paperclip-runtime/x"]) expect(() => openAiWorkspaceRelativePath(value)).toThrow();
    const directory = await root();
    await expect(materializeOpenAiWorkspace(payload([{ path: "file", kind: "dir" }, { path: "file", kind: "dir" }]), path.join(directory, "duplicate"), empty)).rejects.toThrow("path_conflict");
    await expect(materializeOpenAiWorkspace(payload([{ path: "link", kind: "symlink", target: "/tmp" }]), path.join(directory, "symlink"), empty)).rejects.toThrow("symlink_change");
    await expect(materializeOpenAiWorkspace(payload([{ path: "missing/file", kind: "file", mode: 420, data: "" }]), path.join(directory, "parent"), empty)).rejects.toThrow("parent_invalid");
  });
  it("restores text, binary, additions and deletions without changing Git metadata", async () => {
    const directory = await root(); const target = path.join(directory, "target"); await mkdir(target);
    await writeFile(path.join(target, ".git"), "gitdir: controller-owned");
    await writeFile(path.join(target, "old"), "before"); await writeFile(path.join(target, "deleted"), "remove");
    const baseline = await captureDirectorySnapshot(target, { exclude: [".git"] });
    const source = path.join(directory, "source");
    await materializeOpenAiWorkspace(payload([{ path: "old", kind: "file", mode: 420, data: Buffer.from("after").toString("base64") }, { path: "binary", kind: "file", mode: 420, data: "AAEC/w==" }]), source, serializeDirectorySnapshot(baseline) as LegacySerializedDirectorySnapshot);
    await mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" });
    expect(await readFile(path.join(target, "old"), "utf8")).toBe("after");
    expect(await readFile(path.join(target, "binary"))).toEqual(Buffer.from([0, 1, 2, 255]));
    await expect(readFile(path.join(target, "deleted"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(target, ".git"), "utf8")).toBe("gitdir: controller-owned");
  });
  it("preflights all conflicts before applying any file", async () => {
    const directory = await root(); const target = path.join(directory, "target"); await mkdir(target);
    await writeFile(path.join(target, "a"), "before"); await writeFile(path.join(target, "z"), "before");
    const baseline = await captureDirectorySnapshot(target, { exclude: [] });
    await writeFile(path.join(target, "z"), "concurrent user edit");
    const source = path.join(directory, "source");
    await materializeOpenAiWorkspace(payload(["a", "z"].map((name) => ({ path: name, kind: "file", mode: 420, data: Buffer.from("remote edit").toString("base64") }))), source, serializeDirectorySnapshot(baseline) as LegacySerializedDirectorySnapshot);
    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject" })).rejects.toThrow();
    expect(await readFile(path.join(target, "a"), "utf8")).toBe("before");
    expect(await readFile(path.join(target, "z"), "utf8")).toBe("concurrent user edit");
  });
});

it("stages an isolated workspace and instruction/skill bundles without uploading small inputs or ignored secrets", async () => {
  const directory = await root(); const source = path.join(directory, "source"); const worktree = path.join(directory, "worktree");
  await mkdir(source);
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "-q", source); await writeFile(path.join(source, "seed.txt"), "baseline");
  await writeFile(path.join(source, ".gitignore"), ".env\n"); git("-C", source, "add", ".");
  git("-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed");
  git("-C", source, "worktree", "add", "--detach", worktree, "HEAD");
  await writeFile(path.join(worktree, ".env"), "PRIVATE_TEST_SECRET=do-not-stage");
  const instructions = path.join(directory, "instructions"); const skill = path.join(directory, "skill");
  await mkdir(instructions); await mkdir(skill); await writeFile(path.join(instructions, "AGENTS.md"), "Instructions"); await writeFile(path.join(skill, "SKILL.md"), "Skill");
  const request = vi.fn(() => { throw new Error("unexpected network request"); }); vi.stubGlobal("fetch", request);
  const profile = await prepareOpenAiHostedWorkspace({ apiKey: "test-only", stateRoot: path.join(directory, "state"), execution: {
    provider: { kind: "openai_managed", openaiProfile: { profileId: "profile", apiRevision: "agents=v1", reasoningEffort: "medium", environment: { type: "openai_hosted", container_size: "medium", network: { access: "disabled" } }, maxEstimatedSessionCostUsd: 2, timeoutSeconds: 180 } },
    binding: { companyId: "company", runId: "run", issueId: "issue", agentId: "agent" }, workspace: { cwd: worktree }, session: { lifecyclePolicy: { mode: "per_turn" } },
    runtimeContext: { instructions: { bundle: { rootPath: instructions } }, skills: [{ runtimeName: "skill", bundle: { rootPath: skill } }] },
  } as never });
  expect(request).not.toHaveBeenCalled();
  if (profile?.environment.type !== "openai_hosted") throw new Error("missing hosted profile");
  const files = profile.environment.files!;
  expect(files.some((file) => file.path.endsWith("instructions-upload.tar"))).toBe(true);
  expect(files.some((file) => file.path.endsWith("skill-0-upload.tar"))).toBe(true);
  expect(files.some((file) => file.path === "/workspace/paperclip-export.py")).toBe(true);
  for (const [index, file] of files.entries()) {
    if (file.type !== "inline" || !file.path.endsWith(".tar")) continue;
    const tar = path.join(directory, `inspect-${index}.tar`); await writeFile(tar, Buffer.from(file.data, "base64"));
    expect(execFileSync("tar", ["-tf", tar], { encoding: "utf8" }).split("\n").map((entry) => entry.replace(/^\.\//, ""))).not.toContain(".env");
  }
});

it("rejects hosted planning before provisioning a writable environment", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  await expect(prepareOpenAiHostedWorkspace({ stateRoot: "/unused", apiKey: "test-only", execution: {
    provider: { kind: "openai_managed", openaiProfile: { environment: { type: "openai_hosted" } } }, executionMode: "plan",
  } as never })).rejects.toThrow("planning_requires_tools_only");
  expect(request).not.toHaveBeenCalled();
});

it.each(["success", "conflict", "publication retry", "changed export", "reset after import", "recreated workspace"])("merges before output handoff and preserves recovery: %s", async (scenario) => {
  const directory = await root(); const workspace = path.join(directory, "workspace");
  const stateRoot = path.join(directory, "state"); const hosted = path.join(stateRoot, "openai-hosted");
  await mkdir(workspace); await mkdir(hosted, { recursive: true }); await mkdir(path.join(stateRoot, "runner"));
  await writeFile(path.join(workspace, "seed.txt"), "before");
  const binding = { companyId: "company", runId: "run", issueId: "issue", agentId: "agent" };
  const baseline = serializeDirectorySnapshot(await captureDirectorySnapshot(workspace, { exclude: [] }));
  await writeFile(path.join(hosted, "state.json"), JSON.stringify({ binding, cwd: await realpath(workspace), baseline, ignoredPaths: [], uploadedFileIds: [] }), { mode: 0o600 });
  await writeFile(path.join(stateRoot, "runner", "managed-provider-state.json"), JSON.stringify({ runId: "run", descriptor: { kind: "openai_managed" }, providerSessionId: "sess_owned", durableEventCursor: JSON.stringify({ lastTurnId: "turn_owned" }) }), { mode: 0o600 });
  const bytes = payload([{ path: "seed.txt", kind: "file", mode: 420, data: Buffer.from("after").toString("base64") }]);
  if (scenario === "conflict") await writeFile(path.join(workspace, "seed.txt"), "local edit");
  const publicationRetry = !["success", "conflict"].includes(scenario);
  let failPublication = publicationRetry;
  let wireBytes = bytes;
  let expectedWorkspace = "after";
  const handoff = vi.spyOn(PaperclipRunnerToolAuthority.prototype, "execute").mockImplementation(async function (this: PaperclipRunnerToolAuthority, call) {
    expect(call).toMatchObject({ tool: "register_deliverable", arguments: { idempotencyKey: "openai-output:sess_owned:artifact_owned", contentRef: "paperclip-workspace.json" } });
    expect(this.binding.workspaceRoot).toBe("/workspace/outputs");
    expect(await this.binding.readRemoteWorkspaceFile!(call.arguments as never)).toEqual(bytes);
    expect(await readFile(path.join(workspace, "seed.txt"), "utf8")).toBe(expectedWorkspace);
    if (failPublication) { failPublication = false; throw new Error("publication unavailable"); }
    return { disposition: "applied" };
  });
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/artifacts?order=asc&limit=100")) return Response.json({ data: [{ id: "artifact_owned", turn_id: "turn_owned", path: "/workspace/outputs/paperclip-workspace.json" }], has_more: false });
    if (url.endsWith("/artifacts/artifact_owned/content")) return new Response(new Uint8Array(wireBytes));
    expect(url).toBe("https://api.openai.com/v1/agents/sessions/sess_owned"); expect(init.method).toBe("DELETE");
    expect(handoff).toHaveBeenCalledTimes(publicationRetry ? 2 : 1);
    expect(await readFile(path.join(workspace, "seed.txt"), "utf8")).toBe(expectedWorkspace);
    return Response.json({ deleted: true });
  });
  vi.stubGlobal("fetch", request);
  const finalize = () => finalizeOpenAiHostedWorkspace({ db: {} as never, stateRoot, apiKey: "test-only", execution: {
    binding, workspace: { cwd: workspace }, provider: { kind: "openai_managed", openaiProfile: { environment: { type: "openai_hosted" } } },
  } as never });
  if (scenario === "conflict") {
    await expect(finalize()).rejects.toThrow();
    expect(handoff).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(workspace, "seed.txt"), "utf8")).toBe("local edit");
    expect(JSON.parse(await readFile(path.join(hosted, "state.json"), "utf8"))).not.toHaveProperty("finalized");
    return;
  }
  if (publicationRetry) {
    await expect(finalize()).rejects.toThrow("publication unavailable");
    expect(request).toHaveBeenCalledTimes(2);
    const state = JSON.parse(await readFile(path.join(hosted, "state.json"), "utf8"));
    expect(state).not.toHaveProperty("finalized");
    expect(state.workspaceMerged).toMatchObject({ sessionId: "sess_owned", turnId: "turn_owned", artifactsSha256: expect.any(String) });
    expectedWorkspace = scenario === "reset after import" ? "before" : "local edit after import";
    await writeFile(path.join(workspace, "seed.txt"), expectedWorkspace);
    if (scenario === "recreated workspace") {
      await rename(workspace, `${workspace}-imported`);
      await mkdir(workspace);
      await writeFile(path.join(workspace, "seed.txt"), expectedWorkspace);
      await expect(finalize()).rejects.toThrow("merged_workspace_replaced");
      expect(handoff).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(4);
      return;
    }
    if (scenario === "changed export") {
      wireBytes = payload([{ path: "seed.txt", kind: "file", mode: 420, data: Buffer.from("changed remote").toString("base64") }]);
      await expect(finalize()).rejects.toThrow("merged_outputs_changed");
      expect(handoff).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(4);
      expect(await readFile(path.join(workspace, "seed.txt"), "utf8")).toBe(expectedWorkspace);
      return;
    }
  }
  await finalize();
  expect(request).toHaveBeenCalledTimes(publicationRetry ? 5 : 3);
  expect(JSON.parse(await readFile(path.join(hosted, "state.json"), "utf8"))).toMatchObject({ remoteDeleted: true, finalized: { sessionId: "sess_owned", turnId: "turn_owned" } });
});
