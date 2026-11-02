import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { materializeAsset } from "./runtime-context.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { executeWorkspaceTool, readAssignedSkill, readWorkspaceUploadFile, runnerBridgeDefinitions, workspaceCommandSandboxAvailable, settleRunnerBridgeRead } from "./runner-bridge-tools.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const root = async () => { const directory = await mkdtemp(join(tmpdir(), "dot-bridge-")); roots.push(directory); return directory; };
const authorize = async () => {};
describe("Runner workspace bridge", () => {
  it("guards new writes, existing content, traversal and symlinks", async () => {
    const directory = await root(), outside = await root();
    const result = await executeWorkspaceTool(directory, "workspace_write", { path: "hello.txt", text: "hello 🌍", expectedSha256: null }, authorize) as any;
    expect(result.byteSize).toBe(Buffer.byteLength("hello 🌍"));
    expect(await executeWorkspaceTool(directory, "workspace_read", { path: "hello.txt" }, authorize)).toMatchObject({ text: "hello 🌍", sha256: result.sha256 });
    await expect(executeWorkspaceTool(directory, "workspace_write", { path: "hello.txt", text: "overwrite", expectedSha256: null }, authorize)).rejects.toThrow();
    await expect(executeWorkspaceTool(directory, "workspace_write", { path: "hello.txt", text: "overwrite", expectedSha256: "0".repeat(64) }, authorize)).rejects.toThrow("conflict");
    await executeWorkspaceTool(directory, "workspace_write", { path: "hello.txt", text: "updated", expectedSha256: result.sha256 }, authorize);
    await expect(executeWorkspaceTool(directory, "workspace_read", { path: "../hello.txt" }, authorize)).rejects.toThrow();
    await writeFile(join(outside, "private.txt"), "PRIVATE");
    await symlink(outside, join(directory, "outside"));
    await expect(readWorkspaceUploadFile(directory, "../private.txt")).rejects.toThrow();
    await expect(readWorkspaceUploadFile(directory, "outside/private.txt")).rejects.toThrow("symlink_denied");
    expect((await readWorkspaceUploadFile(directory, "hello.txt")).toString()).toBe("updated");
    await expect(executeWorkspaceTool(directory, "workspace_read", { path: "outside/private.txt" }, authorize)).rejects.toThrow("symlink");
  });
  it.each(["workspace", "skill"])("preserves Unicode characters across %s text pages", async mode => {
    const text = "a".repeat(5999) + "🌍" + "z".repeat(6000) + "🚀";
    const directory = await root();
    await writeFile(join(directory, "unicode.txt"), text);
    const bundle = await materializeAsset([{ path: "SKILL.md", content: Buffer.from(text), mode: 0o444 }]);
    const context = { skills: [{ key: "unicode", runtimeName: "unicode", versionId: "version-1", bundle }] } as any;
    const read = async (offset: number) => (mode === "workspace"
      ? executeWorkspaceTool(directory, "workspace_read", { path: "unicode.txt", offset }, authorize)
      : readAssignedSkill(context, { skill: "unicode", offset })) as Promise<{ text: string; nextOffset: number | null; sha256: string; byteSize: number }>;
    const first = await read(0);
    expect(first.nextOffset).toBe(5999);
    expect(first.text).toBe("a".repeat(5999));
    let combined = first.text, next = first.nextOffset;
    while (next !== null) {
      const page = await read(next);
      expect(page.sha256).toBe(first.sha256);
      expect(page.byteSize).toBe(Buffer.byteLength(text));
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      combined += page.text;
      next = page.nextOffset;
    }
    expect(combined).toBe(text);
    await expect(read(6000)).rejects.toThrow("offset_splits_character");
  });

  it("excludes instance state from workspace reads, writes, listings and upload reads", async () => {
    const directory = await root();
    await mkdir(join(directory, ".paperclip"));
    await writeFile(join(directory, ".paperclip", ".env"), "SYNTHETIC_INSTANCE_SECRET");
    await mkdir(join(directory, "nested", ".PaPeRcLiP"), { recursive: true });
    for (const path of [".paperclip/.env", "nested/.PaPeRcLiP/config.json"]) {
      await expect(executeWorkspaceTool(directory, "workspace_read", { path }, authorize)).rejects.toThrow("instance_state_denied");
      await expect(executeWorkspaceTool(directory, "workspace_write", { path, text: "overwrite", expectedSha256: null }, authorize)).rejects.toThrow("instance_state_denied");
      await expect(readWorkspaceUploadFile(directory, path)).rejects.toThrow("instance_state_denied");
    }
    await expect(executeWorkspaceTool(directory, "workspace_list", { path: ".paperclip" }, authorize)).rejects.toThrow("instance_state_denied");
    expect(await executeWorkspaceTool(directory, "workspace_list", { path: "" }, authorize)).toMatchObject({ entries: [{ name: "nested" }] });
    expect(await readFile(join(directory, ".paperclip", ".env"), "utf8")).toBe("SYNTHETIC_INSTANCE_SECRET");
  });

  it.skipIf(!workspaceCommandSandboxAvailable())("denies command access to instance keys while preserving ordinary workspace work", async () => {
    const directory = join(await root(), "project.[safe]");
    await mkdir(directory);
    await mkdir(join(directory, ".paperclip"));
    await mkdir(join(directory, "nested", ".PaPeRcLiP"), { recursive: true });
    const keys = [".paperclip/.env", "nested/.PaPeRcLiP/config.json"];
    for (const key of keys) await writeFile(join(directory, key), "SYNTHETIC_INSTANCE_SECRET");
    for (const key of keys) {
      const read = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/cat", args: [key] }, authorize) as any;
      expect(read.exitCode).not.toBe(0);
      expect(read.output).not.toContain("SYNTHETIC_INSTANCE_SECRET");
      const write = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/sh", args: ["-c", 'printf overwrite > "$1"', "sh", key] }, authorize) as any;
      expect(write.exitCode).not.toBe(0);
      expect(await readFile(join(directory, key), "utf8")).toBe("SYNTHETIC_INSTANCE_SECRET");
    }
    const ordinary = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/sh", args: ["-c", "printf hello > result.txt"] }, authorize) as any;
    expect(ordinary.exitCode).toBe(0);
    expect(await readFile(join(directory, "result.txt"), "utf8")).toBe("hello");
  });

  it.skipIf(process.platform === "linux")("does not expose or execute commands without descendant containment", async () => {
    const directory = await root();
    expect(workspaceCommandSandboxAvailable()).toBe(false);
    const tools = runnerBridgeDefinitions({ workspace: true, skills: false, api: false, mode: "standard" }).map(tool => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["workspace_list", "workspace_read", "workspace_write"]));
    expect(tools).not.toContain("workspace_run");
    await expect(executeWorkspaceTool(directory, "workspace_run", {
      program: "/bin/sh", args: ["-c", "printf escaped > unexpected.txt"],
    }, authorize)).rejects.toThrow("command_sandbox_unavailable");
    await expect(readFile(join(directory, "unexpected.txt"))).rejects.toThrow();
  });

  it.skipIf(!workspaceCommandSandboxAvailable()).each(["completion", "timeout", "revocation"])("terminates detached descendants on %s", async mode => {
      const directory = await root();
      await writeFile(join(directory, "detach.py"), `import os, time, sys
if os.fork() == 0:
    os.setsid()
    for fd in (0, 1, 2):
        os.close(fd)
    for tick in range(500):
        with open("ticks.txt", "w") as out:
            out.write(str(tick))
        time.sleep(0.02)
    os._exit(0)
while not os.path.exists("ticks.txt"):
    time.sleep(0.01)
if sys.argv[1] != "completion":
    time.sleep(20)
`);
      let revoked = false;
      const result = await executeWorkspaceTool(directory, "workspace_run", {
        program: "/usr/bin/python3", args: ["detach.py", mode], timeoutMs: mode === "timeout" ? 1000 : 5000,
      }, async () => {
        if (revoked) throw new Error("revoked");
        if (mode === "revocation") revoked = await readFile(join(directory, "ticks.txt")).then(() => true, () => false);
      }) as any;
      expect(result.stopped).toBe(mode === "timeout" ? "timeout" : mode === "revocation" ? "authority_revoked" : null);
      const final = await readFile(join(directory, "ticks.txt"), "utf8");
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await readFile(join(directory, "ticks.txt"), "utf8")).toBe(final);
    });

  it("serializes overlapping writes so only one observed hash can commit", async () => {
    const directory = await root();
    const initial = await executeWorkspaceTool(directory, "workspace_write", { path: "shared.txt", text: "initial", expectedSha256: null }, authorize) as any;
    let entered!: () => void, release!: () => void, authorizations = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = executeWorkspaceTool(directory, "workspace_write", { path: "shared.txt", text: "first", expectedSha256: initial.sha256 }, async () => {
      if (++authorizations === 2) { entered(); await gate; }
    });
    await waiting;
    const second = executeWorkspaceTool(directory, "workspace_write", { path: "shared.txt", text: "second", expectedSha256: initial.sha256 }, authorize);
    const observed = Promise.allSettled([first, second]);
    release();
    const results = await observed;
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "runner_workspace_write_conflict" }) });
    expect(await readFile(join(directory, "shared.txt"), "utf8")).toBe("first");
  });

  it.skipIf(!workspaceCommandSandboxAvailable())("runs useful commands but denies files outside the workspace and injected credentials", async () => {
    const directory = await root(), outside = await root();
    const secret = join(outside, "private.txt"); await writeFile(secret, "PRIVATE");
    const success = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/sh", args: ["-c", "printf hello > output.txt; printf '%s' \"${PAPERCLIP_SECRETS_MASTER_KEY-unset}\"" ] }, authorize);
    expect(success).toMatchObject({ exitCode: 0, output: "unset", stopped: null });
    expect(await readFile(join(directory, "output.txt"), "utf8")).toBe("hello");
    const read = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/cat", args: [secret] }, authorize);
    expect(read).toMatchObject({ exitCode: 1 }); expect(String((read as any).output)).not.toContain("PRIVATE");
    const write = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/sh", args: ["-c", 'printf stolen > "$1"', "sh", secret] }, authorize);
    expect(write).toMatchObject({ exitCode: 1 }); expect(await readFile(secret, "utf8")).toBe("PRIVATE");
  });
  it.skipIf(!workspaceCommandSandboxAvailable())("stops its owned process on authority loss and bounds output", async () => {
    const directory = await root(); let calls = 0;
    const result = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/sleep", args: ["20"] }, async () => { if (++calls > 2) throw new Error("revoked"); });
    expect(result).toMatchObject({ stopped: "authority_revoked" });
    const large = await executeWorkspaceTool(directory, "workspace_run", { program: "/bin/sh", args: ["-c", "yes x | head -c 50000"] }, authorize) as any;
    expect(large.truncated).toBe(true); expect(Buffer.byteLength(large.output)).toBeLessThanOrEqual(24000);
  });
  it("reads only a pinned skill file and detects tampering", async () => {
    const bundle = await materializeAsset([{ path: "SKILL.md", content: Buffer.from("# Assigned skill\nUse the pinned instructions."), mode: 0o444 }]);
    const context = { skills: [{ key: "assigned", runtimeName: "assigned", versionId: "version-1", bundle }] } as any;
    expect(await readAssignedSkill(context, { skill: "assigned" })).toMatchObject({ versionId: "version-1", text: "# Assigned skill\nUse the pinned instructions." });
    await expect(readAssignedSkill(context, { skill: "not-assigned" })).rejects.toThrow("not_assigned");
    await expect(readAssignedSkill(context, { skill: "assigned", path: "../private" })).rejects.toThrow();
    await expect(readAssignedSkill(context, { skill: "assigned", path: "not-pinned.txt" })).rejects.toThrow("not_pinned");
    await expect(readAssignedSkill({ ...context, skills: [{ ...context.skills[0], bundle: { ...bundle, manifestDigest: createHash("sha256").update("different").digest("hex") } }] }, { skill: "assigned" })).rejects.toThrow("manifest_digest");
  });

  it("settles missing-file reads without disclosing host paths or leaving an unknown effect", async () => {
    const directory = await root();
    const result = await settleRunnerBridgeRead(() => executeWorkspaceTool(directory, "workspace_read", { path: "missing.txt" }, authorize));
    expect(result).toMatchObject({ outcome: "failed", code: "runner_bridge_file_not_found" });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(await settleRunnerBridgeRead(async () => { throw new Error("runner_skill_file_not_pinned"); })).toMatchObject({ outcome: "failed", code: "runner_skill_file_not_pinned" });
  });

  it("advertises only available tools in the current work mode", () => {
    const tools = runnerBridgeDefinitions({ workspace: false, skills: false, api: false, mode: "ask" }).map(tool => tool.name);
    expect(tools).toEqual(["get_identity", "list_people"]);
    expect(runnerBridgeDefinitions({ workspace: true, skills: true, api: true, mode: "planning" }).map(tool => tool.name)).not.toContain("workspace_run");
  });
});
