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
      () => {
        events.push("initialize:error");
      },
    );
    pending = enqueueOpenCodeProxyInput(
      pending,
      async () => {
        events.push("thread:start");
      },
      () => {
        events.push("thread:error");
      },
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
      (error) => {
        events.push((error as Error).message);
      },
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
  const bodies: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }> }> }> }> = [];
  const { createServer } = await import("node:http");
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); response.end("{}"); });
  });
  await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("collector did not bind");
  const child = spawn(process.execPath, [proxy, "--paperclip-trusted-opencode-executable", fd === undefined ? executable : "/proc/self/fd/3"], {
    env: { ...process.env, PAPERCLIP_OPENCODE_RUNTIME_DIR: runtime, OPENROUTER_API_KEY: "fixture-key",
      PAPERCLIP_RUN_ID: "stale-launch-run", PAPERCLIP_OBSERVABILITY_OPENCODE: "1",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
      OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=fixture-company" },
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
    send({ id: 3, method: "turn/start", params: { paperclipRunId: "current-run-1", input: [{ type: "text", text: JSON.stringify({ schema: "paperclip.native-model-envelope.v3", task: { prompt: "invalid-tool-feedback completion-feedback" }, completionContract: { revision: "proxy-v1", criteria: [{ id: "objective", requirement: "Complete the fixture." }] } }) }] } });
    await response(3);
    await expect.poll(() => messages.find(message => message.method === "item/tool/call"), { timeout: 5_000 }).toBeDefined();
    const call = messages.find(message => message.method === "item/tool/call")!;
    expect(call.params!.tool).toBe("paperclip_finish");
    const toolFrames = messages.filter(message => (message.params?.item as { id?: string } | undefined)?.id === "part-invalid");
    expect(toolFrames.map(message => message.method)).toEqual(["item/started", "item/updated", "item/completed"]);
    expect(toolFrames.at(-1)?.params).toMatchObject({
      threadId: call.params!.threadId, turnId: call.params!.turnId,
      item: { id: "part-invalid", type: "builtinToolCall", tool: "invalid", status: "failed", output: "Tool not found: fixture_missing" },
    });
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
      await expect.poll(() => bodies.length, { timeout: 5_000 }).toBe(1);
      // The warm second run has its own contract revision. Runnerd sends it with
      // the run identity; the proxy's launch parameters still name proxy-v1.
      send({ id: 5, method: "turn/start", params: { paperclipRunId: "current-run-2",
        paperclipCompletionContract: { revision: "proxy-v2", criterionIds: ["objective"] },
        input: [{ type: "text", text: JSON.stringify({ schema: "paperclip.native-model-envelope.v3", task: { prompt: "completion-feedback" }, completionContract: { revision: "proxy-v2", criteria: [{ id: "objective", requirement: "Complete the fixture." }] } }) }] } });
      await response(5);
      await expect.poll(() => messages.find(message => message.method === "item/tool/call" && message.id !== call.id), { timeout: 5_000 }).toBeDefined();
      const warmCall = messages.find(message => message.method === "item/tool/call" && message.id !== call.id)!;
      send({ id: warmCall.id, result: { success: true, contentItems: [{ type: "inputText", text: "Accepted." }] } });
      await expect.poll(() => bodies.length, { timeout: 5_000 }).toBe(2);
      expect(bodies.map(body => body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
        .find(attribute => attribute.key === "paperclip.run.id")?.value.stringValue)).toEqual(["current-run-1", "current-run-2"]);
      child.stdin!.end();
    }
    await expect.poll(() => exited, { timeout: 5_000 }).toBe(true);
    await exit;
    const results = messages.filter(message => message.method === "paperclip/runResult");
    expect(results).toHaveLength(respond ? 2 : 0);
    if (respond) expect(JSON.stringify(results[1])).toContain("proxy-v2");
  } finally {
    child.kill("SIGTERM");
    if (!exited) {
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1_000))]);
      if (!exited && child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      await exit;
    }
    input.close();
    await new Promise<void>(resolve => { collector.close(() => resolve()); collector.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Runnerd restores a saved session before it applies `run.attach`: the proxy
// launches with the saved run's contract while its environment already names
// the attached run. The attached run's contract still arrives on turn/start.
it("binds the current contract when a restored launch already names the attached run", async () => {
  const { execFileSync, spawn } = await import("node:child_process");
  const { chmod, mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { closeSync, openSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { createInterface } = await import("node:readline");
  const root = await mkdtemp(join(tmpdir(), "opencode-proxy-restored-contract-"));
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
  await (await import("node:fs/promises")).writeFile(proxy, execFileSync(process.execPath, ["--input-type=module", "-e", `import { bundleVerifiedProviderEntrypoints } from "./scripts/build-verified-provider-entrypoints.mjs"; const entries = await bundleVerifiedProviderEntrypoints({ write: false }); process.stdout.write(entries.find(({ entrypoint }) => entrypoint.name === "opencode-app-server-proxy").verifiedResult.outputFiles[0].contents);`], { maxBuffer: 16 * 1024 * 1024 }));
  const fd = process.platform === "linux" ? openSync(executable, "r") : undefined;
  const child = spawn(process.execPath, [proxy, "--paperclip-trusted-opencode-executable", fd === undefined ? executable : "/proc/self/fd/3"], {
    env: { ...process.env, PAPERCLIP_OPENCODE_RUNTIME_DIR: join(root, "runtime"), OPENROUTER_API_KEY: "fixture-key",
      PAPERCLIP_RUN_ID: "attached-run-2" },
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
    // Launch parameters carry the saved run's contract.
    send({ id: 2, method: "thread/start", params: { cwd: root, model: "openrouter/deepseek/deepseek-v4-flash-0731", completionContract: { revision: "1", criterionIds: ["objective"] }, conversationMode: "prepared" } });
    await response(2);
    send({ id: 3, method: "turn/start", params: { paperclipRunId: "attached-run-2",
      paperclipCompletionContract: { revision: "2", criterionIds: ["pending_comment_1", "pending_comment_2"] },
      input: [{ type: "text", text: JSON.stringify({ schema: "paperclip.native-model-envelope.v3", task: { prompt: "completion-feedback" },
        completionContract: { revision: "2", criteria: [{ id: "pending_comment_1", requirement: "Use a readable font." }, { id: "pending_comment_2", requirement: "Add a contact section." }] } }) }] } });
    await response(3);
    // The finish claim reaches the controller on its first try.
    await expect.poll(() => messages.find(message => message.method === "item/tool/call"), { timeout: 5_000 }).toBeDefined();
    const call = messages.find(message => message.method === "item/tool/call")!;
    expect(call.params).toMatchObject({ tool: "paperclip_finish", arguments: { completionClaim: { contractRevision: "2" } } });
    send({ id: call.id, result: { success: true, contentItems: [{ type: "inputText", text: "Accepted." }] } });
    await expect.poll(() => messages.filter(message => message.method === "paperclip/runResult").length, { timeout: 5_000 }).toBe(1);
    expect(JSON.stringify(messages.find(message => message.method === "paperclip/runResult"))).toContain('"contractRevision":"2"');
    child.stdin!.end();
    await expect.poll(() => exited, { timeout: 5_000 }).toBe(true);
    await exit;
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
