import { describe, expect, it } from "vitest";

import { enqueueOpenCodeProxyInput } from "./opencode-proxy-input.js";

describe("OpenCode proxy input sequencing", () => {
  it("drains requests in order before EOF shutdown", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    let pending = Promise.resolve();
    pending = enqueueOpenCodeProxyInput(
      pending,
      async () => {
        events.push("initialize:start");
        await firstBlocked;
        events.push("initialize:complete");
      },
      () => events.push("initialize:error"),
    );
    pending = enqueueOpenCodeProxyInput(
      pending,
      async () => {
        events.push("thread:start");
      },
      () => events.push("thread:error"),
    );
    const shutdown = pending.then(() => {
      events.push("shutdown");
    });

    await Promise.resolve();
    expect(events).toEqual(["initialize:start"]);
    releaseFirst();
    await shutdown;
    expect(events).toEqual([
      "initialize:start",
      "initialize:complete",
      "thread:start",
      "shutdown",
    ]);
  });

  it("reports a failed queued request without rejecting the drain", async () => {
    const events: string[] = [];
    let pending = Promise.resolve();
    pending = enqueueOpenCodeProxyInput(
      pending,
      async () => {
        throw new Error("initialize failed");
      },
      (error) => events.push((error as Error).message),
    );

    await pending;
    expect(events).toEqual(["initialize failed"]);
  });
});

it.each([true, false])("settles a real proxy interrupt with controller feedback or EOF (feedback: %s)", async respond => {
  const { execFileSync, spawn } = await import("node:child_process");
  const { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = await import("node:fs/promises");
  const { closeSync, openSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { createInterface } = await import("node:readline");
  const root = await mkdtemp(join(tmpdir(), "opencode-proxy-interrupt-feedback-"));
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
  const fd = process.platform === "linux" ? openSync(executable, "r") : undefined;
  const runtime = join(root, "runtime");
  const child = spawn(process.execPath, [proxy, "--paperclip-trusted-opencode-executable", fd === undefined ? executable : "/proc/self/fd/3"], {
    env: { ...process.env, PAPERCLIP_OPENCODE_RUNTIME_DIR: runtime, OPENROUTER_API_KEY: "fixture-key" },
    stdio: fd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", fd],
    detached: process.platform !== "win32",
  });
  if (fd !== undefined) closeSync(fd);
  const messages: Array<{ id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }> = [];
  const input = createInterface({ input: child.stdout! });
  input.on("line", line => messages.push(JSON.parse(line)));
  child.stderr!.resume();
  let exited = false;
  const exit = new Promise<void>(resolve => child.once("exit", () => { exited = true; resolve(); }));
  const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  const response = async (id: number) => {
    await expect.poll(() => messages.find(message => message.id === id), { timeout: 5_000 }).toBeDefined();
    const value = messages.find(message => message.id === id)!;
    expect(value.error).toBeUndefined();
    return value.result;
  };
  try {
    send({ id: 1, method: "initialize", params: {} });
    await response(1);
    send({ id: 2, method: "thread/start", params: { cwd: root, model: "openrouter/deepseek/deepseek-v4-flash-0731", completionContract: { revision: "proxy-v1", criterionIds: ["objective"] }, conversationMode: "prepared" } });
    await response(2);
    send({ id: 3, method: "turn/start", params: { input: [{ type: "text", text: JSON.stringify({ schema: "paperclip.native-model-envelope.v3", task: { prompt: "completion-feedback" }, completionContract: { revision: "proxy-v1", criteria: [{ id: "objective", requirement: "Complete the fixture." }] } }) }] } });
    await response(3);
    await expect.poll(() => messages.find(message => message.method === "item/tool/call"), { timeout: 5_000 }).toBeDefined();
    const call = messages.find(message => message.method === "item/tool/call")!;
    expect(call.params!.tool).toBe("paperclip_finish");
    const feedback = "Accepted. Include [Saved document](/PAP/issues/PAP-1#document-plan).";
    // The interrupt is ahead of the response on stdin. Commands stay serial,
    // but their awaited response must not queue behind the command itself.
    send({ id: 4, method: "turn/interrupt", params: { turnId: call.params!.turnId } });
    if (respond) {
      send({ id: call.id, result: { success: true, contentItems: [{ type: "inputText", text: feedback }] } });
    } else {
      child.stdin!.end();
    }
    expect(await response(4)).toBe(true);
    if (respond) {
      const sessions = (await readdir(runtime, { withFileTypes: true })).filter(entry => entry.isDirectory());
      await expect.poll(async () => JSON.parse(await readFile(join(runtime, sessions[0]!.name, "data/fake-completion-feedback.json"), "utf8"))).toMatchObject([
        { result: { content: [{ text: expect.stringContaining(feedback) }] } },
      ]);
      child.stdin!.end();
    }
    await expect.poll(() => exited, { timeout: 5_000 }).toBe(true);
    await exit;
    expect(messages.filter(message => message.method === "paperclip/runResult")).toHaveLength(respond ? 1 : 0);
  } finally {
    child.kill("SIGTERM");
    if (!exited) {
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1_000))]);
      if (!exited && child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      await exit;
    }
    input.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
