import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { expect, it } from "vitest";

// runnerd rejects any provider stdout line above CODEX_APP_SERVER_MAX_FRAME_BYTES.
const RUNNERD_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";

type RpcFrame = { id?: string | number; method?: string; result?: unknown; error?: unknown };

async function startProxy(root: string, proxy: string, executable: string, runtime: string) {
  const fd = process.platform === "linux" ? openSync(executable, "r") : undefined;
  const child = spawn(process.execPath, [proxy, "--paperclip-trusted-opencode-executable", fd === undefined ? executable : "/proc/self/fd/3"], {
    // Keep an enclosing Paperclip run's launch bindings out of this fixture.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PAPERCLIP_"))),
      PAPERCLIP_OPENCODE_RUNTIME_DIR: runtime, OPENROUTER_API_KEY: "fixture-key",
      PAPERCLIP_RUN_ID: "resume-frame-run", PAPERCLIP_NORMALIZED_SESSION_ID: "resume-frame-session" },
    stdio: fd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", fd],
    detached: process.platform !== "win32",
    cwd: root,
  });
  if (fd !== undefined) closeSync(fd);
  const lineBytes: number[] = [];
  const frames: RpcFrame[] = [];
  const input = createInterface({ input: child.stdout! });
  input.on("line", line => {
    lineBytes.push(Buffer.byteLength(line));
    frames.push(JSON.parse(line) as RpcFrame);
  });
  child.stderr!.resume();
  let exited = false;
  const exit = new Promise<void>(done => child.once("exit", () => { exited = true; done(); }));
  const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  const response = async (id: number) => {
    await expect.poll(() => frames.find(frame => frame.id === id), { timeout: 10_000 }).toBeDefined();
    const frame = frames.find(entry => entry.id === id)!;
    expect(frame.error).toBeUndefined();
    return frame.result as Record<string, unknown>;
  };
  const stop = async () => {
    child.stdin!.end();
    await Promise.race([exit, new Promise(done => setTimeout(done, 5_000))]);
    if (!exited && child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    await exit;
    input.close();
  };
  return { send, response, stop, lineBytes };
}

it("resumes a session whose OpenCode message history exceeds runnerd's frame limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-proxy-thread-read-"));
  const launchRoot = join(root, `.paperclip-verified-executable-${randomUUID().replaceAll("-", "")}`);
  await mkdir(launchRoot, { mode: 0o700 });
  await chmod(launchRoot, 0o700);
  const executable = join(launchRoot, "launch");
  const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
  execFileSync("cc", ["-x", "c", "-o", executable, "-"], { input: `#include <unistd.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { char **args = calloc(argc + 2, sizeof(char *)); args[0] = ${JSON.stringify(process.execPath)}; args[1] = ${JSON.stringify(fixture)}; for (int i = 1; i < argc; i++) args[i + 1] = argv[i]; execv(args[0], args); return 127; }` });
  if (process.platform === "darwin") {
    execFileSync("codesign", ["--force", "--sign", "-", executable]);
    execFileSync("codesign", ["--verify", "--strict", executable]);
  }
  await chmod(executable, 0o500);
  const proxy = join(root, "proxy.cjs");
  await writeFile(proxy, execFileSync(process.execPath, ["--input-type=module", "-e", `import { bundleVerifiedProviderEntrypoints } from "./scripts/build-verified-provider-entrypoints.mjs"; const entries = await bundleVerifiedProviderEntrypoints({ write: false }); process.stdout.write(entries.find(({ entrypoint }) => entrypoint.name === "opencode-app-server-proxy").verifiedResult.outputFiles[0].contents);`], { maxBuffer: 16 * 1024 * 1024 }));
  const runtime = join(root, "runtime");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const first = await startProxy(root, proxy, executable, runtime);
    let threadId: string;
    try {
      first.send({ id: 1, method: "initialize", params: {} });
      await first.response(1);
      first.send({ id: 2, method: "thread/start", params: { cwd: workspace, model: MODEL } });
      threadId = ((await first.response(2)).thread as { id: string }).id;
    } finally {
      await first.stop();
    }

    // The persisted OpenCode session has accumulated more retained message
    // content than one runnerd stdout frame may carry.
    const sessions = (await readdir(runtime, { withFileTypes: true })).filter(entry => entry.isDirectory());
    expect(sessions).toHaveLength(1);
    await writeFile(join(runtime, sessions[0]!.name, "data", "fake-message-history-bytes"), String(RUNNERD_MAX_FRAME_BYTES + 1024 * 1024));

    // Mirror runnerd's restore sequence: thread/resume, then thread/read to
    // discover whether a provider turn is still active.
    const resumed = await startProxy(root, proxy, executable, runtime);
    try {
      resumed.send({ id: 1, method: "initialize", params: {} });
      await resumed.response(1);
      resumed.send({ id: 2, method: "thread/resume", params: { threadId, cwd: workspace, model: MODEL } });
      expect(((await resumed.response(2)).thread as { id: string }).id).toBe(threadId);
      resumed.send({ id: 3, method: "thread/read", params: { threadId, includeTurns: true } });
      const read = await resumed.response(3);
      expect(read.thread).toMatchObject({ id: threadId, turns: [] });
      expect(Math.max(...resumed.lineBytes)).toBeLessThan(RUNNERD_MAX_FRAME_BYTES);
    } finally {
      await resumed.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
