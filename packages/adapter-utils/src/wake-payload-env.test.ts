import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWakePayloadEnv, renderWakePayloadFileNote, WAKE_PAYLOAD_INLINE_MAX_BYTES } from "./wake-payload-env.js";
import { isForbiddenConfigEnvKey, redactEnvForLogs, runChildProcess } from "./server-utils.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";

const exec = promisify(execFile);
const payload = JSON.stringify({ description: "🙂 café\n".repeat(60_000), messages: ["first", "last"] });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map((fn) => fn())); });
const childScript = `
  const fs = require('node:fs');
  const p = process.env.PAPERCLIP_WAKE_PAYLOAD_PATH;
  const body = fs.readFileSync(p, 'utf8');
  let stdin = '';
  process.stdin.on('data', c => stdin += c);
  process.stdin.on('end', () => console.log(JSON.stringify({
    digest: require('node:crypto').createHash('sha256').update(body).digest('hex'),
    path: p, inline: process.env.PAPERCLIP_WAKE_PAYLOAD_JSON ?? null, stdin,
    mode: fs.statSync(p).mode & 511, directoryMode: fs.statSync(require('node:path').dirname(p)).mode & 511
  })));
`;

describe("lossless wake payload transport", () => {
  it("keeps small payload bytes unchanged and measures UTF-8 bytes at the boundary", async () => {
    const inline = "é".repeat(WAKE_PAYLOAD_INLINE_MAX_BYTES / 2);
    const small = await prepareWakePayloadEnv({ PAPERCLIP_WAKE_PAYLOAD_JSON: inline, PAPERCLIP_WAKE_PAYLOAD_PATH: "/stale" });
    expect(small.env).toEqual({ PAPERCLIP_WAKE_PAYLOAD_JSON: inline });
    expect(small.filePath).toBeNull();
    const large = await prepareWakePayloadEnv({ PAPERCLIP_WAKE_PAYLOAD_JSON: inline + "é" });
    cleanup.push(large.cleanup);
    expect(await fs.readFile(large.filePath!, "utf8")).toBe(inline + "é");
    expect(large.env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBeUndefined();
  });

  it("uses separate private files for overlapping runs and never mutates the input", async () => {
    const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload, PAPERCLIP_RUN_ID: "same-run-retry" };
    const [first, second] = await Promise.all([prepareWakePayloadEnv(env), prepareWakePayloadEnv(env)]);
    cleanup.push(first.cleanup, second.cleanup);
    expect(first.filePath).not.toBe(second.filePath);
    expect(env).toEqual({ PAPERCLIP_WAKE_PAYLOAD_JSON: payload, PAPERCLIP_RUN_ID: "same-run-retry" });
    await first.cleanup();
    expect(await fs.readFile(second.filePath!, "utf8")).toBe(payload);
    expect(renderWakePayloadFileNote(second.env)).toContain(JSON.stringify(second.filePath));
  });

  it("accounts for shell quoting expansion on remote launches", async () => {
    const quoted = JSON.stringify({ description: "'".repeat(8_000) });
    expect(Buffer.byteLength(quoted)).toBeLessThan(WAKE_PAYLOAD_INLINE_MAX_BYTES);
    const delivery = await prepareWakePayloadEnv({ PAPERCLIP_WAKE_PAYLOAD_JSON: quoted }, async (script) =>
      (await exec("sh", ["-c", script])).stdout);
    cleanup.push(delivery.cleanup);
    expect(await fs.readFile(delivery.filePath!, "utf8")).toBe(quoted);
    expect(delivery.env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBeUndefined();
  });

  it("launches a real child with the complete large payload, preserves stdin, and removes the file", async () => {
    const result = await runChildProcess("large-wake", process.execPath, ["-e", childScript], {
      cwd: os.tmpdir(), env: { PAPERCLIP_WAKE_PAYLOAD_JSON: payload }, stdin: "original prompt",
      timeoutSec: 10, graceSec: 1, onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const received = JSON.parse(result.stdout);
    expect(received).toMatchObject({ digest: digest(payload), inline: null, stdin: "original prompt" });
    if (process.platform !== "win32") expect(received).toMatchObject({ mode: 0o600, directoryMode: 0o700 });
    await expect(fs.stat(path.dirname(received.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "linux")("reproduces Linux E2BIG when the original payload is used as an env entry", () => {
    // execFile's custom promisify wrapper can throw synchronously on E2BIG.
    // spawnSync exposes the native launch error without that Promise boundary.
    const result = spawnSync(process.execPath, ["-e", ""], { env: { PAPERCLIP_WAKE_PAYLOAD_JSON: payload } });
    expect(result.error).toMatchObject({ code: "E2BIG" });
  });

  it("cleans up when the child cannot start", async () => {
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    await expect(runChildProcess("failed-wake", "/paperclip-test-no-such-command", [], {
      cwd: os.tmpdir(), env: { PAPERCLIP_WAKE_PAYLOAD_JSON: payload }, timeoutSec: 5, graceSec: 1, onLog: async () => {},
    })).rejects.toThrow("Failed to start command");
    const directory = await mkdtemp.mock.results[0]!.value;
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "linux")("binds only the owned payload file into a confined process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wake-mount-test-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const fakeBwrap = path.join(root, "fake-bwrap.cjs");
    await fs.writeFile(fakeBwrap, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), path: process.env.PAPERCLIP_WAKE_PAYLOAD_PATH }));`, { mode: 0o700 });
    const result = await runChildProcess("confined-wake", process.execPath, ["-e", ""], {
      cwd: root, env: { PAPERCLIP_WAKE_PAYLOAD_JSON: payload }, timeoutSec: 5, graceSec: 1, onLog: async () => {},
      localProcessSandbox: { workspaceDir: root, filesystemScope: "workspace", command: fakeBwrap },
    });
    expect(result.exitCode).toBe(0);
    const received = JSON.parse(result.stdout);
    const index = received.args.indexOf(received.path);
    expect(received.args.slice(index - 1, index + 2)).toEqual(["--ro-bind", received.path, received.path]);
    const mounts = received.args.flatMap((arg: string, index: number) =>
      arg === "--bind" || arg === "--ro-bind" ? [received.args[index + 1]] : []);
    expect(mounts).not.toContain(path.dirname(received.path));
    await expect(fs.stat(received.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up after a timeout", async () => {
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    const result = await runChildProcess("timeout-wake", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: os.tmpdir(), env: { PAPERCLIP_WAKE_PAYLOAD_JSON: payload }, timeoutSec: 0.2, graceSec: 1, onLog: async () => {},
    });
    expect(result.timedOut).toBe(true);
    const directory = await mkdtemp.mock.results[0]!.value;
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("delivers exact bytes through bounded remote commands and cleans up after the remote child", async () => {
    const commands: string[] = [];
    const result = await runAdapterExecutionTargetProcess("remote-wake", {
      kind: "remote", transport: "sandbox", remoteCwd: os.tmpdir(),
      runner: { execute: async (input) => {
        for (const value of [...(input.args ?? []), ...Object.values(input.env ?? {})]) {
          expect(Buffer.byteLength(value)).toBeLessThan(32 * 1024);
        }
        commands.push((input.args ?? []).join(" "));
        return runChildProcess("remote-test-command", input.command, input.args ?? [], {
          cwd: os.tmpdir(), env: input.env ?? {}, stdin: input.stdin, timeoutSec: 10, graceSec: 1, onLog: async () => {},
        });
      } },
    }, process.execPath, ["-e", childScript], {
      cwd: os.tmpdir(), env: { PAPERCLIP_WAKE_PAYLOAD_JSON: payload }, stdin: "remote prompt",
      timeoutSec: 10, graceSec: 1, onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const received = JSON.parse(result.stdout);
    expect(received).toMatchObject({ digest: digest(payload), inline: null, stdin: "remote prompt", mode: 0o600, directoryMode: 0o700 });
    await expect(fs.stat(path.dirname(received.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(commands.filter((s) => s.includes("base64 -d")).length).toBeGreaterThan(1);
  });

  it.each(["upload", "verification"])("fails closed on remote %s failure without leaking payload chunks", async (failure) => {
    let directory = "";
    let appends = 0;
    const promise = prepareWakePayloadEnv({ PAPERCLIP_WAKE_PAYLOAD_JSON: payload }, async (script) => {
      if (script.startsWith("umask 077 && mkdir")) directory = script.match(/'(\/tmp\/paperclip-wake-[^']+)'/)![1]!;
      if (script.includes("base64 -d") && ++appends === 2 && failure === "upload") throw new Error(script);
      if (script.startsWith("test ") && failure === "verification") throw new Error(script);
      return (await exec("sh", ["-c", script])).stdout;
    });
    await expect(promise).rejects.toThrow(/^Could not deliver the complete wake payload file\.$/);
    expect(directory).not.toBe("");
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("safely cleans up an ambiguous directory creation failure (occupied=%s)", async (occupied) => {
    let directory = "";
    await expect(prepareWakePayloadEnv({ PAPERCLIP_WAKE_PAYLOAD_JSON: payload }, async (script) => {
      if (script.startsWith("umask 077 && mkdir")) {
        directory = script.match(/'(\/tmp\/paperclip-wake-[^']+)'/)![1]!;
        cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
        await fs.mkdir(directory, { mode: 0o700 });
        if (occupied) await fs.writeFile(path.join(directory, "other-owner"), "preserve this");
        throw new Error(occupied ? "directory exists" : "acknowledgement lost after mkdir");
      }
      return (await exec("sh", ["-c", script])).stdout;
    })).rejects.toThrow("Could not create the private wake payload directory.");
    if (occupied) expect(await fs.readFile(path.join(directory, "other-owner"), "utf8")).toBe("preserve this");
    else await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects configured file paths and keeps wake contents out of invocation logs", () => {
    expect(isForbiddenConfigEnvKey("PAPERCLIP_WAKE_PAYLOAD_PATH")).toBe(true);
    const logged = redactEnvForLogs({ PAPERCLIP_WAKE_PAYLOAD_JSON: payload });
    expect(logged.PAPERCLIP_WAKE_PAYLOAD_JSON).toBe(`[wake payload: ${Buffer.byteLength(payload)} bytes]`);
    expect(JSON.stringify(logged)).not.toContain("café");
  });
});
