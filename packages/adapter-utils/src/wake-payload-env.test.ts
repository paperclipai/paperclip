import * as ssh from "./ssh.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLocalProcessSandboxSpawnTarget } from "./local-process-sandbox.js";
import { buildInvocationEnvForLogs, runChildProcess } from "./server-utils.js";
import {
  PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA,
  PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES,
  formatPaperclipWakePayloadDiagnostic,
  materializePaperclipWakePayloadEnv,
  paperclipWakePayloadFileNote,
  paperclipWakePayloadRemoteInstallCommand,
  paperclipWakePayloadSandboxMounts,
  retargetPaperclipWakePayloadEnv,
} from "./wake-payload-env.js";

const MARKER = "Zażółć gęślą jaźń";
const SECRET = "sekret-łódź-DO-NOT-LOG";

function oversizedWakeJson(): string {
  return JSON.stringify({
    marker: MARKER,
    secret: SECRET,
    note: "ponowienie",
    history: "x".repeat(600 * 1024),
  });
}

function jsonOfByteLength(bytes: number): string {
  const wrapper = Buffer.byteLength('{"p":""}');
  const filler = "a".repeat(bytes - wrapper);
  const value = JSON.stringify({ p: filler });
  if (Buffer.byteLength(value) !== bytes) {
    throw new Error(`expected ${bytes} bytes, got ${Buffer.byteLength(value)}`);
  }
  return value;
}

async function spawnNode(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: string | null; status: number | null; stdout: string }> {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { env });
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : null;
      resolve({ code, status: null, stdout: "" });
      return;
    }
    let settled = false;
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      resolve({ code: error.code ?? null, status: null, stdout });
    });
    child.on("exit", (status) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, status, stdout });
    });
  });
}

describe("paperclip wake payload environment", () => {
  it("keeps a small payload inline, including Polish characters", async () => {
    const payload = JSON.stringify({ marker: MARKER, note: "mały pakiet" });
    const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload, PAPERCLIP_WAKE_PAYLOAD_PATH: "/tmp/stale.json" };
    const delivery = await materializePaperclipWakePayloadEnv(env, { runId: "small" });

    expect(delivery.delivery).toBe("inline");
    expect(env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBe(payload);
    expect(env.PAPERCLIP_WAKE_PAYLOAD_PATH).toBeUndefined();
    expect(paperclipWakePayloadFileNote(env)).toBe("");
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES);
  });

  it("spills the first byte past the inline ceiling without changing the document", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-boundary-"));
    const payload = jsonOfByteLength(PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES + 1);
    const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload, PAPERCLIP_RUN_SCRATCH_DIR: dir };
    const delivery = await materializePaperclipWakePayloadEnv(env, {
      runId: "boundary",
      scratchDir: dir,
    });
    const file = await fs.readFile(delivery.path ?? "", "utf8");

    expect(delivery.delivery).toBe("file");
    expect(delivery.rewritten).toBe(true);
    expect(file).toBe(payload);
    expect(JSON.parse(file)).toEqual(JSON.parse(payload));
    expect(Buffer.byteLength(env.PAPERCLIP_WAKE_PAYLOAD_JSON)).toBeLessThanOrEqual(
      PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform === "linux")(
    "reproduces spawn E2BIG for a ~600KB PAPERCLIP_WAKE_PAYLOAD_JSON value",
    async () => {
      const payload = oversizedWakeJson();
      expect(Buffer.byteLength(payload)).toBeGreaterThan(500 * 1024);
      const result = await spawnNode(["-e", "process.exit(0)"], {
        PATH: process.env.PATH,
        PAPERCLIP_WAKE_PAYLOAD_JSON: payload,
      });
      expect(result.code).toBe("E2BIG");
    },
  );

  it("starts the process after the spill, including a retry, and the child reads the full context", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-wake-"));
    const payload = oversizedWakeJson();
    const script = `
const fs = require("node:fs");
const pointer = process.env.PAPERCLIP_WAKE_PAYLOAD_JSON || "";
const filePath = process.env.PAPERCLIP_WAKE_PAYLOAD_PATH || "";
if (!filePath) process.exit(2);
if (pointer.includes(${JSON.stringify(SECRET)}) || pointer.includes(${JSON.stringify(MARKER)})) process.exit(3);
const file = fs.readFileSync(filePath);
const text = file.toString("utf8");
if (!text.includes(${JSON.stringify(MARKER)})) process.exit(4);
if (!text.includes("ponowienie")) process.exit(5);
if (file.length !== ${Buffer.byteLength(payload)}) process.exit(6);
const parsed = JSON.parse(text);
if (parsed.secret !== ${JSON.stringify(SECRET)}) process.exit(7);
if (parsed.history.length !== ${600 * 1024}) process.exit(8);
process.stdout.write("full-context-ok");
`;
    const scriptPath = path.join(scratch, "read-wake.js");
    await fs.writeFile(scriptPath, script);
    const logs: string[] = [];

    const runOnce = async () => {
      const env = {
        PATH: process.env.PATH ?? "",
        PAPERCLIP_WAKE_PAYLOAD_JSON: payload,
        PAPERCLIP_RUN_SCRATCH_DIR: scratch,
      };
      return await runChildProcess("retry-run", process.execPath, [scriptPath], {
        cwd: scratch,
        env,
        timeoutSec: 30,
        graceSec: 1,
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
      });
    };

    const first = await runOnce();
    const second = await runOnce();
    const diagnostic = logs.join("");
    const stored = await fs.readFile(path.join(scratch, "paperclip-wake-payload.json"));

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toContain("full-context-ok");
    expect(second.stdout).toContain("full-context-ok");
    expect(stored.toString("utf8")).toBe(payload);
    expect(createHash("sha256").update(stored).digest("hex")).toHaveLength(64);
    expect(diagnostic).toContain("delivery=file");
    expect(diagnostic).toContain(`bytes=${Buffer.byteLength(payload)}`);
    expect(diagnostic).toMatch(/envBytes=\d+/);
    expect(diagnostic).not.toContain(SECRET);
    expect(diagnostic).not.toContain(MARKER);
    expect(diagnostic).not.toContain("ponowienie");
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("records only sizes when an oversized wake payload would otherwise be logged", () => {
    const payload = oversizedWakeJson();
    const logged = buildInvocationEnvForLogs({
      PAPERCLIP_WAKE_PAYLOAD_JSON: payload,
      PAPERCLIP_API_KEY: "super-secret-token",
    });
    expect(logged.PAPERCLIP_WAKE_PAYLOAD_JSON).toBe(
      `[omitted wake payload: ${Buffer.byteLength(payload)} bytes]`,
    );
    expect(logged.PAPERCLIP_WAKE_PAYLOAD_JSON).not.toContain(SECRET);
    expect(logged.PAPERCLIP_API_KEY).not.toContain("super-secret-token");
  });

  it("tells the agent to read the run file and keeps the pointer free of task text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-note-"));
    const payload = oversizedWakeJson();
    const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload };
    const delivery = await materializePaperclipWakePayloadEnv(env, { runId: "note", scratchDir: dir });
    const note = paperclipWakePayloadFileNote(env);
    const pointer = JSON.parse(env.PAPERCLIP_WAKE_PAYLOAD_JSON);

    expect(pointer.schema).toBe(PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA);
    expect(pointer.path).toBe(delivery.path);
    expect(pointer.bytes).toBe(Buffer.byteLength(payload));
    expect(JSON.stringify(pointer)).not.toContain(SECRET);
    expect(note).toContain("PAPERCLIP_WAKE_PAYLOAD_PATH");
    expect(note).toContain(`${pointer.bytes} bytes`);
    expect(note).not.toContain(SECRET);
    expect(note).not.toContain(MARKER);
    expect(formatPaperclipWakePayloadDiagnostic(delivery)).not.toContain(SECRET);
    const mode = (await fs.stat(delivery.path ?? "")).mode & 0o777;
    expect(mode).toBe(0o600);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps a second materialize of the same pointer idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-idem-"));
    const payload = oversizedWakeJson();
    const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload };
    const first = await materializePaperclipWakePayloadEnv(env, { runId: "idem", scratchDir: dir });
    const second = await materializePaperclipWakePayloadEnv(env, { runId: "idem", scratchDir: dir });
    expect(first.rewritten).toBe(true);
    expect(second.rewritten).toBe(false);
    expect(second.path).toBe(first.path);
    expect(await fs.readFile(first.path ?? "", "utf8")).toBe(payload);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not put the wake document on the remote install command", () => {
    const payload = oversizedWakeJson();
    const command = paperclipWakePayloadRemoteInstallCommand("/tmp/paperclip-wake-run.json");
    expect(Buffer.byteLength(command)).toBeLessThan(PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES);
    expect(command).not.toContain(SECRET);
    expect(command).not.toContain(payload.slice(0, 32));
    expect(command).toContain("chmod 600");
  });

  it.runIf(process.platform === "linux")(
    "mounts the run scratch directory into a workspace sandbox",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-sandbox-"));
      const workspace = path.join(root, "workspace");
      const scratch = path.join(root, "paperclip-run-sandbox");
      await fs.mkdir(workspace);
      await fs.mkdir(scratch);
      const payload = oversizedWakeJson();
      const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload, PAPERCLIP_RUN_SCRATCH_DIR: scratch };
      await materializePaperclipWakePayloadEnv(env, { runId: "sandbox", scratchDir: scratch });
      const mounts = paperclipWakePayloadSandboxMounts(env);
      const target = await buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        options: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          managedPaths: mounts,
        },
      });

      expect(mounts).toEqual([{ path: scratch, access: "rw" }]);
      expect(target.args).toEqual(expect.arrayContaining(["--bind", scratch, scratch]));
      expect(target.args).toContain("--tmpfs");
      expect(target.args).toContain("--unshare-pid");
      await fs.rm(root, { recursive: true, force: true });
    },
  );
});


describe("wake file review regressions", () => {
  it("rejects a missing pointer file without LOCAL_PATH", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-missing-"));
    try {
      const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: JSON.stringify({
        schema: PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA,
        path: path.join(dir, "missing.json"), bytes: 0,
        sha256: createHash("sha256").update("").digest("hex"),
      }) };
      await expect(materializePaperclipWakePayloadEnv(env, { runId: "missing" }))
        .rejects.toThrow("Refusing to start without the full context");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("keeps transfer bytes private before EOF and atomically replaces an existing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-transfer-"));
    const target = path.join(dir, "wake 'quoted'.json");
    await fs.writeFile(target, "old", { mode: 0o644 });
    const child = spawn("sh", ["-c", `umask 022; ${paperclipWakePayloadRemoteInstallCommand(target)}`]);
    const completion = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject); child.on("close", resolve);
    });
    try {
      child.stdin.write("private-partial");
      await vi.waitFor(async () => {
        const names = (await fs.readdir(dir)).filter((name) => name !== path.basename(target));
        expect(names).toHaveLength(1);
        const staging = path.join(dir, names[0]!);
        expect(await fs.readFile(staging, "utf8")).toBe("private-partial");
        expect((await fs.stat(staging)).mode & 0o777).toBe(0o600);
      });
      expect(await fs.readFile(target, "utf8")).toBe("old");
      child.stdin.end("-complete");
      expect(await completion).toBe(0);
      expect(await fs.readFile(target, "utf8")).toBe("private-partial-complete");
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
      expect(await fs.readdir(dir)).toEqual([path.basename(target)]);
    } finally {
      child.stdin.end(); child.kill(); await completion;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});


describe("direct SSH wake retries", () => {
  it("publishes each attempt from the retained source and passes only the remote pointer", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-ssh-wake-"));
    const payload = oversizedWakeJson();
    const env: Record<string, string> = {
      PATH: `${scratch}:${process.env.PATH ?? ""}`,
      PAPERCLIP_WAKE_PAYLOAD_JSON: payload,
      PAPERCLIP_RUN_SCRATCH_DIR: scratch,
    };
    const publish = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({ stdout: "", stderr: "" });
    const build = vi.spyOn(ssh, "buildSshSpawnTarget").mockResolvedValue({
      command: "ssh", args: [], cleanup: async () => {},
    });
    try {
      // An inert local executable replaces only SSH transport, never the wake pipeline.
      await fs.writeFile(path.join(scratch, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await runChildProcess("ssh-wake", "claude", [], {
          cwd: scratch, env, timeoutSec: 30, graceSec: 1, onLog: async () => {},
          remoteExecution: { host: "unused.example.test", port: 22, username: "test",
            remoteCwd: "/remote/workspace", remoteWorkspacePath: "/remote/workspace",
            privateKey: null, knownHosts: null, strictHostKeyChecking: true },
        })).exitCode).toBe(0);
        expect(await fs.readFile(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH!, "utf8")).toBe(payload);
        expect(JSON.parse(env.PAPERCLIP_WAKE_PAYLOAD_JSON).path).toBe(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH);
      }
      expect(publish).toHaveBeenCalledTimes(2);
      expect(build).toHaveBeenCalledTimes(2);
      for (const call of publish.mock.calls) expect(call[2]?.stdin).toBe(payload);
      for (const [input] of build.mock.calls) {
        expect(input.env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH).toBeUndefined();
        expect(input.env.PAPERCLIP_WAKE_PAYLOAD_PATH).toBe("/tmp/paperclip-wake-ssh-wake.json");
        expect(JSON.parse(input.env.PAPERCLIP_WAKE_PAYLOAD_JSON).path).toBe(input.env.PAPERCLIP_WAKE_PAYLOAD_PATH);
      }
    } finally {
      vi.restoreAllMocks();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
});


describe("wake payload retarget validation", () => {
  it.each(["missing pointer", "changed bytes", "changed hash"])(
    "refuses publication with %s and preserves the source env",
    async (failure) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-retarget-"));
      try {
        const env: Record<string, string> = { PAPERCLIP_WAKE_PAYLOAD_JSON: oversizedWakeJson() };
        await materializePaperclipWakePayloadEnv(env, { runId: "retarget", scratchDir: dir });
        if (failure === "missing pointer") delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
        else {
          const body = await fs.readFile(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH!);
          if (failure === "changed hash") body[body.length - 2] = 32;
          await fs.writeFile(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH!,
            failure === "changed bytes" ? Buffer.concat([body, Buffer.from(" ")]) : body);
        }
        const before = { ...env };
        const publish = vi.fn(async () => {});
        await expect(retargetPaperclipWakePayloadEnv({ env, runId: "retarget", publish }))
          .rejects.toThrow(failure === "missing pointer" ? "pointer is missing" : "different document");
        expect(publish).not.toHaveBeenCalled();
        expect(env).toEqual(before);
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    },
  );

  it("publishes the exact verified UTF-8 document and changes only the destination", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-retarget-"));
    try {
      const payload = oversizedWakeJson();
      const env: Record<string, string> = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload };
      await materializePaperclipWakePayloadEnv(env, { runId: "retarget", scratchDir: dir });
      const pointer = JSON.parse(env.PAPERCLIP_WAKE_PAYLOAD_JSON);
      const publish = vi.fn(async () => {});
      await expect(retargetPaperclipWakePayloadEnv({ env, runId: "retarget", publish })).resolves.toBe(true);
      expect(publish).toHaveBeenCalledExactlyOnceWith("/tmp/paperclip-wake-retarget.json", payload);
      expect(JSON.parse(env.PAPERCLIP_WAKE_PAYLOAD_JSON)).toEqual({
        ...pointer, path: "/tmp/paperclip-wake-retarget.json",
      });
      expect(env.PAPERCLIP_WAKE_PAYLOAD_PATH).toBe("/tmp/paperclip-wake-retarget.json");
      expect(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH).toBeUndefined();
      expect(await fs.readFile(pointer.path, "utf8")).toBe(payload);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
