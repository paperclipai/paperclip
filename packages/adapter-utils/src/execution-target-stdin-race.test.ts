import { execFile as execFileCallback, spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  getProcessSessionRemoteSource,
  startAdapterExecutionTargetProcessSessionBridge,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import { createCommandManagedSandboxCallbackBridgeQueueClient } from "./sandbox-callback-bridge.js";
import { runChildProcess, type RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

// Regression coverage for the stdin file race (parent PAP-4037): the host sends
// each ACP message as a file in the sandbox stdin directory, and a poller in
// the sandbox reads the file and writes the data to the child. Two defects lost
// a message. The host write was not atomic, so the poller could read an empty
// or partial `.json` file. The poller deleted the file before it validated the
// content, so an empty read was lost and a partial read stopped the loop.
describe("stdin file race (parent PAP-4037)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // ---- Poller wrapper harness -------------------------------------------

  type DeliveredFrame = { seq: number; type: string; stream?: string; data?: string; message?: string };

  // Run the real emitted poller wrapper as a node process. The streamed variant
  // writes one JSON frame per line to its stdout, so the test reads the frames
  // directly. The child command is `cat`, so every byte the poller writes to
  // the child stdin comes back as a `data` frame.
  async function startPollerWrapper(options?: { maxRetries?: number }) {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-stdin-poll-"));
    cleanupDirs.push(sessionDir);
    const stdinDir = path.join(sessionDir, "stdin");
    await mkdir(stdinDir, { recursive: true });

    const wrapperPath = path.join(sessionDir, "wrapper.mjs");
    await writeFile(wrapperPath, getProcessSessionRemoteSource({ outputToStdout: true }), "utf8");

    const config = { command: "cat", args: [] as string[], cwd: sessionDir, env: {} };
    const commandPayload = Buffer.from(JSON.stringify(config), "utf8").toString("base64");

    const env: Record<string, string> = {
      ...process.env,
      PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
      PAPERCLIP_PROCESS_SESSION_COMMAND_B64: commandPayload,
    };
    if (options?.maxRetries != null) {
      env.PAPERCLIP_PROCESS_SESSION_STDIN_MAX_RETRIES = String(options.maxRetries);
    }

    const child = spawn(process.execPath, [wrapperPath], {
      cwd: sessionDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const frames: DeliveredFrame[] = [];
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        frames.push(JSON.parse(line) as DeliveredFrame);
      }
    });

    const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));

    return {
      sessionDir,
      stdinDir,
      frames,
      // Write a complete stdin file with an atomic rename, so the test never
      // creates its own partial-write race.
      writeFileAtomic: async (name: string, content: string) => {
        const finalPath = path.join(stdinDir, name);
        const tempPath = `${finalPath}.writing`;
        await writeFile(tempPath, content, "utf8");
        await rename(tempPath, finalPath);
      },
      // Write a `.json` file directly, so a reader can observe it before the
      // content lands. This simulates the non-atomic-write window.
      writeFileRaw: async (name: string, content: string) => {
        await writeFile(path.join(stdinDir, name), content, "utf8");
      },
      exited,
      kill: () => child.kill("SIGKILL"),
    };
  }

  function stdinMessage(text: string): string {
    return `${JSON.stringify({ type: "stdin", data: Buffer.from(text, "utf8").toString("base64") })}\n`;
  }

  const stdinEndMessage = `${JSON.stringify({ type: "stdinEnd" })}\n`;

  // Concatenate every stdout `data` frame and decode it back to text.
  function collectDelivered(frames: DeliveredFrame[]): string {
    return frames
      .filter((frame) => frame.type === "data" && frame.stream === "stdout" && typeof frame.data === "string")
      .map((frame) => Buffer.from(frame.data as string, "base64").toString("utf8"))
      .join("");
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await delay(20);
    }
    throw new Error("Timed out waiting for condition.");
  }

  // ---- Poller tests -----------------------------------------------------

  it("delivers a stdin file that appears empty first and then gets content", async () => {
    const poller = await startPollerWrapper();

    // The file appears empty first (the non-atomic-write window). The poller
    // must keep it and retry, not delete it and lose the message.
    await poller.writeFileRaw("000000000001.json", "");
    await delay(200);
    // The poller keeps the empty file for a later retry. A poller that deletes
    // before it validates would drop the file here and lose the message.
    const afterEmpty = await readdir(poller.stdinDir);
    expect(afterEmpty).toContain("000000000001.json");

    // The content lands in the same file. The poller must deliver it on a later
    // cycle, because it kept the file across the empty read.
    await poller.writeFileAtomic("000000000001.json", stdinMessage("late-payload"));

    await waitFor(() => collectDelivered(poller.frames).includes("late-payload"));

    await poller.writeFileAtomic("000000000002.json", stdinEndMessage);
    await poller.exited;

    expect(collectDelivered(poller.frames)).toBe("late-payload");
    expect(poller.frames.some((frame) => frame.type === "exit")).toBe(true);
  });

  it("keeps polling after a malformed file and still delivers a later valid file", async () => {
    const poller = await startPollerWrapper({ maxRetries: 3 });

    // A malformed file sorts before the valid file. The poller keeps the send
    // order: it holds the later file until it drops the malformed file after the
    // retry limit, then it delivers the later valid file. So one bad file blocks
    // the loop only until the retry limit, not forever.
    await poller.writeFileRaw("000000000001.json", "{ this is not valid json");
    await poller.writeFileAtomic("000000000002.json", stdinMessage("valid-after-bad"));

    await waitFor(() => collectDelivered(poller.frames).includes("valid-after-bad"));

    await poller.writeFileAtomic("000000000003.json", stdinEndMessage);
    await poller.exited;

    expect(collectDelivered(poller.frames)).toBe("valid-after-bad");
    expect(poller.frames.some((frame) => frame.type === "exit")).toBe(true);
  });

  it("does not close the stream on a later stdinEnd while an earlier file awaits retry", async () => {
    const poller = await startPollerWrapper();

    // An earlier stdin file is momentarily unreadable (the non-atomic-write
    // window). A later stdinEnd file is already complete. The poller must keep
    // the send order: it must not read the stdinEnd ahead of the earlier file
    // and close the stream. It must hold the stream open until the earlier file
    // is readable.
    await poller.writeFileRaw("000000000001.json", "");
    await poller.writeFileAtomic("000000000002.json", stdinEndMessage);

    // Give the poller time to scan. The stream stays open, so the child does not
    // exit and no exit frame appears yet.
    await delay(300);
    expect(poller.frames.some((frame) => frame.type === "exit")).toBe(false);

    // The earlier file's content lands. The poller delivers it, then reads the
    // stdinEnd and closes the stream.
    await poller.writeFileAtomic("000000000001.json", stdinMessage("early-payload"));

    await waitFor(() => collectDelivered(poller.frames).includes("early-payload"));
    await poller.exited;

    expect(collectDelivered(poller.frames)).toBe("early-payload");
    expect(poller.frames.some((frame) => frame.type === "exit")).toBe(true);
  });

  it("drops a permanently malformed file after the retry limit and writes an error event", async () => {
    const poller = await startPollerWrapper({ maxRetries: 3 });

    // This file never becomes valid. After the retry limit the poller drops it
    // and writes an error event, so the lost message fails loudly.
    await poller.writeFileRaw("000000000001.json", "{ permanently broken");

    await waitFor(() =>
      poller.frames.some(
        (frame) => frame.type === "error" && typeof frame.message === "string" && frame.message.includes("Dropped unreadable stdin file"),
      ),
    );

    // The loop still works after the drop: a later valid file is delivered.
    await poller.writeFileAtomic("000000000002.json", stdinMessage("still-alive"));
    await waitFor(() => collectDelivered(poller.frames).includes("still-alive"));

    await poller.writeFileAtomic("000000000003.json", stdinEndMessage);
    await poller.exited;

    expect(collectDelivered(poller.frames)).toBe("still-alive");
    expect(poller.frames.some((frame) => frame.type === "exit")).toBe(true);
  });

  it("holds a later stdin file until the missing earlier file appears", async () => {
    const poller = await startPollerWrapper();

    // File 2 is complete, but file 1 has not appeared yet (a host reordering).
    // The poller must not deliver file 2 ahead of the missing file 1. It holds
    // the send order and waits for the earlier file.
    await poller.writeFileAtomic("000000000002.json", stdinMessage("second-payload"));
    await delay(300);
    // File 2 is still on disk and nothing was delivered: the poller holds it.
    const afterHold = await readdir(poller.stdinDir);
    expect(afterHold).toContain("000000000002.json");
    expect(collectDelivered(poller.frames)).toBe("");

    // File 1 arrives. The poller now delivers file 1 then file 2, in send order.
    await poller.writeFileAtomic("000000000001.json", stdinMessage("first-payload"));
    await waitFor(() => collectDelivered(poller.frames).includes("second-payload"));
    expect(collectDelivered(poller.frames)).toBe("first-payloadsecond-payload");

    await poller.writeFileAtomic("000000000003.json", stdinEndMessage);
    await poller.exited;
    expect(poller.frames.some((frame) => frame.type === "exit")).toBe(true);
  });

  it("fails loud and advances past a missing stdin file after the retry limit", async () => {
    const poller = await startPollerWrapper({ maxRetries: 3 });

    // File 1 never appears. File 2 is complete. After the retry limit the poller
    // writes a loud error event and advances past the gap, then delivers file 2.
    // So a permanent reordering fails loud, never silently.
    await poller.writeFileAtomic("000000000002.json", stdinMessage("after-gap"));

    await waitFor(() =>
      poller.frames.some(
        (frame) =>
          frame.type === "error" &&
          typeof frame.message === "string" &&
          frame.message.includes("Advanced past missing stdin files"),
      ),
    );
    await waitFor(() => collectDelivered(poller.frames).includes("after-gap"));

    await poller.writeFileAtomic("000000000003.json", stdinEndMessage);
    await poller.exited;
    expect(collectDelivered(poller.frames)).toBe("after-gap");
    expect(poller.frames.some((frame) => frame.type === "exit")).toBe(true);
  });

  // ---- Host serialization test (drives the real bridge) -----------------

  // A runner that runs each bridge shell script as a real child process, so the
  // test drives the whole legacy-poll bridge: the socket handler, the command-
  // managed `writeTextFile` script, the nohup wrapper, and the output poll.
  function createLocalSandboxRunner(
    onExecute?: (script: string) => Promise<void>,
  ) {
    let counter = 0;
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      }): Promise<RunProcessResult> => {
        counter += 1;
        const script = input.args?.[1] ?? "";
        if (onExecute) await onExecute(script);
        const command =
          input.command === "bash" ? "/bin/bash" : input.command === "sh" ? "/bin/sh" : input.command;
        return runChildProcess(`stdin-order-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
        });
      },
    };
  }

  it("serializes host stdin writes so a slow earlier write still lands first", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-stdin-host-order-"));
    cleanupDirs.push(rootDir);
    // The child echoes every stdin byte to stdout, so the wrapper reports the
    // exact bytes and order the child received on its stdin.
    const childPath = path.join(rootDir, "echo-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', (c) => process.stdout.write(c));\n", "utf8");

    // Record the send-order-relevant event: the completion of each stdin file's
    // finalize (atomic rename). Delay the finalize of the FIRST file, so its
    // write resolves slower than the second. Without serialization the second
    // rename would land first; the per-session chain must keep the send order.
    const finalizeOrder: string[] = [];
    const runner = createLocalSandboxRunner(async (script) => {
      const finalizeMatch = /base64 -d[\s\S]*mv '[^']*\.decoded' '([^']+\.json)'/.exec(script);
      if (finalizeMatch) {
        const remotePath = finalizeMatch[1];
        if (remotePath.endsWith("000000000001.json")) await delay(300);
        finalizeOrder.push(path.posix.basename(remotePath));
      }
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-stdin-host-order",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    let peer: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      const tokenLiteral = /const token = (".*?");/.exec(proxySource)?.[1];
      expect(Number.isFinite(port)).toBe(true);
      const token = JSON.parse(tokenLiteral as string) as string;

      const peerSocket = net.createConnection({ host: "127.0.0.1", port });
      peer = peerSocket;
      peerSocket.setEncoding("utf8");
      peerSocket.on("error", () => undefined);
      const delivered: string[] = [];
      let peerBuffer = "";
      peerSocket.on("data", (chunk: string) => {
        peerBuffer += chunk;
        const lines = peerBuffer.split("\n");
        peerBuffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as { type?: string; stream?: string; data?: string };
          if (frame.type === "data" && frame.stream === "stdout" && typeof frame.data === "string") {
            delivered.push(Buffer.from(frame.data, "base64").toString("utf8"));
          }
        }
      });
      await new Promise<void>((resolve, reject) => {
        peerSocket.once("connect", () => resolve());
        peerSocket.once("error", reject);
      });

      // Send two stdin messages back to back. The first authenticates and writes
      // file 1; the second writes file 2. Both are scheduled before file 1's
      // delayed finalize resolves, so an un-chained handler would race them.
      const head = `${JSON.stringify({ token, type: "stdin", data: Buffer.from("HEAD_ONE_", "utf8").toString("base64") })}\n`;
      const tail = `${JSON.stringify({ token, type: "stdin", data: Buffer.from("TAIL_TWO", "utf8").toString("base64") })}\n`;
      peerSocket.write(head);
      peerSocket.write(tail);

      // The two finalize renames complete in send order, not in the order the
      // delayed and fast writes would otherwise finish.
      await waitFor(() => finalizeOrder.length >= 2, 8_000);
      expect(finalizeOrder.slice(0, 2)).toEqual(["000000000001.json", "000000000002.json"]);

      // End to end: the child receives the two payloads intact and in send
      // order, so the prompt is byte-identical on the child stdin.
      await waitFor(() => delivered.join("").includes("TAIL_TWO"), 8_000);
      expect(delivered.join("")).toBe("HEAD_ONE_TAIL_TWO");
    } finally {
      peer?.destroy();
      await bridge?.stop();
    }
  });

  it("holds stdinEnd on stop until an earlier pending stdin write lands first", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-stdin-stop-order-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "echo-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', (c) => process.stdout.write(c));\n", "utf8");

    // Record each stdin file finalize (atomic rename). `finalizeStarted` marks
    // the start; `finalizeOrder` marks the completion. Delay the FIRST chunk's
    // finalize, so its write is still pending when `stop()` runs. `stop()` must
    // chain the `stdinEnd` write after the pending chunk, so file 2 (stdinEnd)
    // never finishes its rename before file 1.
    const finalizeStarted: string[] = [];
    const finalizeOrder: string[] = [];
    const runner = createLocalSandboxRunner(async (script) => {
      const finalizeMatch = /base64 -d[\s\S]*mv '[^']*\.decoded' '([^']+\.json)'/.exec(script);
      if (finalizeMatch) {
        const name = path.posix.basename(finalizeMatch[1]);
        finalizeStarted.push(name);
        if (name === "000000000001.json") await delay(300);
        finalizeOrder.push(name);
      }
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-stdin-stop-order",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    let peer: net.Socket | null = null;
    let stopped = false;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      const tokenLiteral = /const token = (".*?");/.exec(proxySource)?.[1];
      expect(Number.isFinite(port)).toBe(true);
      const token = JSON.parse(tokenLiteral as string) as string;

      const peerSocket = net.createConnection({ host: "127.0.0.1", port });
      peer = peerSocket;
      peerSocket.setEncoding("utf8");
      peerSocket.on("error", () => undefined);
      peerSocket.on("data", () => undefined);
      await new Promise<void>((resolve, reject) => {
        peerSocket.once("connect", () => resolve());
        peerSocket.once("error", reject);
      });

      // Send one stdin message. It authenticates and writes file 1, whose
      // finalize the runner delays. Wait until that finalize has started, so the
      // write is in flight when `stop()` runs.
      const head = `${JSON.stringify({ token, type: "stdin", data: Buffer.from("HEAD_ONE_", "utf8").toString("base64") })}\n`;
      peerSocket.write(head);
      await waitFor(() => finalizeStarted.includes("000000000001.json"), 8_000);

      // Stop the bridge while file 1's write is still pending. `stop()` awaits
      // the chained `stdinEnd` write, then chains a `shutdown` write after it,
      // so all three finalizes are complete when it returns, in send order.
      await bridge!.stop();
      stopped = true;
      expect(finalizeOrder).toEqual(["000000000001.json", "000000000002.json", "000000000003.json"]);
    } finally {
      peer?.destroy();
      if (!stopped) await bridge?.stop();
    }
  });

  // ---- Host atomic-write tests ------------------------------------------

  // A runner that executes each bridge shell script on the local filesystem,
  // so the test exercises the real command-managed `writeTextFile` script.
  function createLocalShellRunner(scripts: string[]) {
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      }): Promise<RunProcessResult> => {
        const args = input.args ?? [];
        if ((input.command === "sh" || input.command === "bash") && args[0] === "-c" && typeof args[1] === "string") {
          scripts.push(args[1]);
        }
        const command = input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
        try {
          const result = await execFile(command, args, {
            cwd: input.cwd,
            env: { ...process.env, ...input.env },
            maxBuffer: 32 * 1024 * 1024,
          });
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: result.stdout,
            stderr: result.stderr,
            pid: null,
            startedAt: null,
          };
        } catch (error) {
          const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number | null };
          return {
            exitCode: typeof err.code === "number" ? err.code : null,
            signal: null,
            timedOut: false,
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
            pid: null,
            startedAt: null,
          };
        }
      },
    };
  }

  it("finalizes the command-managed host write with an atomic rename onto the .json path", async () => {
    const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-stdin-host-cmd-"));
    cleanupDirs.push(remoteRoot);
    const stdinDir = path.join(remoteRoot, "stdin");
    await mkdir(stdinDir, { recursive: true });

    const scripts: string[] = [];
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner: createLocalShellRunner(scripts),
      remoteCwd: remoteRoot,
      timeoutMs: 30_000,
    });

    const jsonPath = path.join(stdinDir, "000000000001.json");
    const body = `${JSON.stringify({ type: "stdin", data: Buffer.from("host-payload", "utf8").toString("base64") })}\n`;
    await client.writeTextFile(jsonPath, body);

    // The final file holds the complete body.
    expect(await readFile(jsonPath, "utf8")).toBe(body);
    // No temporary upload file remains next to the final file.
    const entries = await readdir(stdinDir);
    expect(entries).toEqual(["000000000001.json"]);

    // The finalize script renames a non-`.json` temporary file onto the final
    // path. It never redirects the decode output straight into the `.json`
    // file, so a reader never sees an empty or partial `.json` file.
    const finalizeScript = scripts.find((script) => script.includes("base64 -d"));
    expect(finalizeScript).toBeDefined();
    expect(finalizeScript).toContain(`mv `);
    expect(finalizeScript).not.toContain(`> '${jsonPath}'`);
    expect(finalizeScript).toContain(`> '${jsonPath}.paperclip-upload.decoded'`);
  });

  it("never exposes a partial .json file under a concurrent reader (command-managed host write)", async () => {
    const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-stdin-host-race-"));
    cleanupDirs.push(remoteRoot);
    const stdinDir = path.join(remoteRoot, "stdin");
    await mkdir(stdinDir, { recursive: true });

    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner: createLocalShellRunner([]),
      remoteCwd: remoteRoot,
      timeoutMs: 30_000,
    });

    const jsonPath = path.join(stdinDir, "000000000001.json");
    // A large body needs many decode bytes, so the write window is wide.
    const bigText = "x".repeat(64 * 1024);
    const body = `${JSON.stringify({ type: "stdin", data: Buffer.from(bigText, "utf8").toString("base64") })}\n`;

    let stop = false;
    const readerErrors: string[] = [];
    let observedComplete = 0;
    const reader = (async () => {
      while (!stop) {
        const raw = await readFile(jsonPath, "utf8").catch(() => null);
        if (raw) {
          try {
            JSON.parse(raw);
            observedComplete += 1;
          } catch (error) {
            readerErrors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
    })();

    for (let round = 0; round < 6; round += 1) {
      await client.remove(jsonPath);
      await client.writeTextFile(jsonPath, body);
    }
    stop = true;
    await reader;

    // Every read of the final file parsed as complete JSON. The reader never
    // saw an empty or partial `.json` file.
    expect(readerErrors).toEqual([]);
    expect(observedComplete).toBeGreaterThan(0);
  });
});

// Coverage for deterministic wrapper shutdown (parent PAP-5307): a bridge
// stop must leave no remote wrapper process and no direct child process
// alive, the host must send no operating-system signal, and the host must
// store no process identifier. These tests drive the real emitted wrapper as
// a node process and, where noted, the real bridge through a local runner.
describe("deterministic remote process-session wrapper shutdown (PAP-5316)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(20);
    }
    throw new Error("Timed out waiting for condition.");
  }

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // A read-only, test-only liveness probe over the real OS process table. It
  // never signals anything; it only greps `ps` output to tell the test
  // whether a specific test-authored script (identified by its own temp file
  // path) is still running. Production host code never does this — it never
  // matches or signals a process by name or command line.
  async function findLivePidsByArgvSubstring(substring: string): Promise<number[]> {
    try {
      const { stdout } = await execFile("ps", ["-eo", "pid=,args="]);
      const pids: number[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = /^(\d+)\s+(.*)$/.exec(trimmed);
        if (match && match[2].includes(substring)) {
          const pid = Number.parseInt(match[1], 10);
          if (Number.isFinite(pid)) pids.push(pid);
        }
      }
      return pids;
    } catch {
      return [];
    }
  }

  type WrapperFrame = {
    seq?: number;
    type?: string;
    stream?: string;
    data?: string;
    code?: number | null;
    signal?: string | null;
    message?: string;
  };

  // A test-only preload module for the wrapper's node process (PAP-5338).
  // This sandbox's filesystems all report a real, working birthtime, so a
  // test cannot reach the two known "no usable creation time" fallbacks by
  // using a real filesystem alone. This preload patches fs.promises.lstat
  // inside the wrapper's own process, for one directory the test names
  // through an env var, so the wrapper observes the exact Stats shape each
  // fallback produces. It never runs unless a test opts in, and it never
  // touches this test file's own process.
  // Kept outside cleanupDirs (which afterEach drains after every single test):
  // this preload file is created once and reused by every test in this
  // describe block, so an early test's cleanup must not delete it out from
  // under a later test.
  let fakeBirthtimePreloadDir: string | null = null;
  afterAll(async () => {
    if (fakeBirthtimePreloadDir) await rm(fakeBirthtimePreloadDir, { recursive: true, force: true }).catch(() => undefined);
  });
  let fakeBirthtimePreloadPath: Promise<string> | null = null;
  async function getFakeBirthtimePreloadPath(): Promise<string> {
    if (!fakeBirthtimePreloadPath) {
      fakeBirthtimePreloadPath = (async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-birthtime-preload-"));
        fakeBirthtimePreloadDir = dir;
        const preloadPath = path.join(dir, "fake-birthtime-preload.cjs");
        await writeFile(
          preloadPath,
          [
            `const fs = require("fs");`,
            `const path = require("path");`,
            `const target = process.env.PAPERCLIP_TEST_FAKE_BIRTHTIME_TARGET;`,
            `const mode = process.env.PAPERCLIP_TEST_FAKE_BIRTHTIME_MODE;`,
            `const sessionDir = process.env.PAPERCLIP_PROCESS_SESSION_DIR;`,
            `if (target && mode && sessionDir) {`,
            `  const resolvedTarget = path.resolve(target === "stdinDir" ? path.join(sessionDir, "stdin") : sessionDir);`,
            `  const originalLstat = fs.promises.lstat.bind(fs.promises);`,
            `  fs.promises.lstat = async (candidatePath, opts) => {`,
            `    const stats = await originalLstat(candidatePath, opts);`,
            `    if (path.resolve(String(candidatePath)) === resolvedTarget) {`,
            `      const fakeValue = mode === "zero" ? 0 : stats.ctimeMs;`,
            `      Object.defineProperty(stats, "birthtimeMs", { value: fakeValue, configurable: true });`,
            `    }`,
            `    return stats;`,
            `  };`,
            `}`,
          ].join("\n"),
          "utf8",
        );
        return preloadPath;
      })();
    }
    return fakeBirthtimePreloadPath;
  }

  // A test-only preload for PAP-5355: it deterministically simulates a
  // same-sandbox peer that wins the gap between the wrapper's final identity
  // check and its removal call. nextProbeFileName() is deterministic (pid +
  // call sequence), so this preload can compute the exact probe path the
  // wrapper itself will check next. It patches fs.promises.lstat inside the
  // wrapper's own process: the first time that call targets the expected
  // probe path, it replaces the path with a peer-owned entry before the real
  // lstat runs, so the wrapper observes the swapped entry's identity, not its
  // own. This is the worst case for the wrapper (the swap always lands
  // before the wrapper's very last look at the path), so a wrapper that
  // still leaves the peer's entry untouched under this preload proves the
  // fix for every less-adversarial timing too. It never runs unless a test
  // opts in, and it never touches this test file's own process.
  let probeSwapPreloadDir: string | null = null;
  afterAll(async () => {
    if (probeSwapPreloadDir) await rm(probeSwapPreloadDir, { recursive: true, force: true }).catch(() => undefined);
  });
  let probeSwapPreloadPath: Promise<string> | null = null;
  async function getProbeSwapPreloadPath(): Promise<string> {
    if (!probeSwapPreloadPath) {
      probeSwapPreloadPath = (async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-swap-preload-"));
        probeSwapPreloadDir = dir;
        const preloadPath = path.join(dir, "probe-swap-preload.cjs");
        await writeFile(
          preloadPath,
          [
            `const fs = require("fs");`,
            `const path = require("path");`,
            `const mode = process.env.PAPERCLIP_TEST_PROBE_SWAP_MODE;`,
            `const seq = process.env.PAPERCLIP_TEST_PROBE_SWAP_SEQ;`,
            `const symlinkTarget = process.env.PAPERCLIP_TEST_PROBE_SWAP_SYMLINK_TARGET;`,
            `if (mode && seq) {`,
            `  const expectedName = ".paperclip-birthtime-probe-" + process.pid + "-" + seq;`,
            `  let swapped = false;`,
            `  const originalLstat = fs.promises.lstat.bind(fs.promises);`,
            `  fs.promises.lstat = async (candidatePath, opts) => {`,
            `    if (!swapped && path.basename(String(candidatePath)) === expectedName) {`,
            `      swapped = true;`,
            `      try { fs.unlinkSync(candidatePath); } catch {}`,
            `      if (mode === "file") fs.writeFileSync(candidatePath, "peer-owned-content");`,
            `      else if (mode === "dir") fs.mkdirSync(candidatePath);`,
            `      else if (mode === "symlink") fs.symlinkSync(symlinkTarget, candidatePath);`,
            `    }`,
            `    return originalLstat(candidatePath, opts);`,
            `  };`,
            `}`,
          ].join("\n"),
          "utf8",
        );
        return preloadPath;
      })();
    }
    return probeSwapPreloadPath;
  }

  // A test-only preload for PAP-5374: it simulates fstat() failing on the
  // wrapper's own just-opened probe file descriptor, the one signal the real
  // filesystem in this sandbox never produces on demand. nextProbeFileName()
  // is deterministic (pid + call sequence), so this preload knows which
  // fs.promises.open() call is the wrapper's probe write and patches only the
  // FileHandle that call returns, leaving every other open() untouched. It
  // never runs unless a test opts in, and it never touches this test file's
  // own process.
  let fstatFailurePreloadDir: string | null = null;
  afterAll(async () => {
    if (fstatFailurePreloadDir) await rm(fstatFailurePreloadDir, { recursive: true, force: true }).catch(() => undefined);
  });
  let fstatFailurePreloadPath: Promise<string> | null = null;
  async function getFstatFailurePreloadPath(): Promise<string> {
    if (!fstatFailurePreloadPath) {
      fstatFailurePreloadPath = (async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-fstat-failure-preload-"));
        fstatFailurePreloadDir = dir;
        const preloadPath = path.join(dir, "fstat-failure-preload.cjs");
        await writeFile(
          preloadPath,
          [
            `const fs = require("fs");`,
            `const path = require("path");`,
            `const seq = process.env.PAPERCLIP_TEST_FSTAT_FAILURE_SEQ;`,
            `if (seq) {`,
            `  const expectedName = ".paperclip-birthtime-probe-" + process.pid + "-" + seq;`,
            `  const originalOpen = fs.promises.open.bind(fs.promises);`,
            `  fs.promises.open = async (targetPath, flags, mode) => {`,
            `    const handle = await originalOpen(targetPath, flags, mode);`,
            `    if (path.basename(String(targetPath)) === expectedName) {`,
            `      handle.stat = async () => {`,
            `        throw new Error("EIO: simulated fstat failure for test");`,
            `      };`,
            `    }`,
            `    return handle;`,
            `  };`,
            `}`,
          ].join("\n"),
          "utf8",
        );
        return preloadPath;
      })();
    }
    return fstatFailurePreloadPath;
  }

  // Run the real emitted wrapper (either variant) as a node process, with no
  // sandbox and no bridge in front of it. The test owns the wrapper's node
  // ChildProcess handle directly, so it can observe the wrapper's own exit
  // without storing or signaling any process identifier itself.
  async function startWrapperProcess(options?: {
    outputToStdout?: boolean;
    command?: string;
    args?: string[];
    maxRetries?: number;
    terminateGraceMs?: number;
    // A dedicated parent for this wrapper's session directory, instead of the
    // shared OS temp directory. A test that must chmod sessionDir's own
    // parent (to force EACCES on sessionDir itself) needs a parent it owns,
    // never the shared OS temp directory every other process on the host
    // also uses.
    parentDir?: string;
    // Makes the wrapper's own process observe an unusable birthtimeMs on one
    // control directory, through the preload above. See PAP-5338 AC-1: a
    // real "no usable creation time" filesystem is not reachable in this
    // sandbox, so the test simulates the exact Stats shape instead.
    fakeBirthtime?: { target: "sessionDir" | "stdinDir"; mode: "zero" | "followCtime" };
    // Makes the wrapper's own process observe a same-sandbox peer replacing
    // its birth-time probe file, through the preload above (PAP-5355). seq 1
    // is sessionDir's probe (the first one captureSessionIdentity() runs).
    probeSwap?: { seq: 1 | 2; mode: "file" | "dir" | "symlink"; symlinkTarget?: string };
    // Makes the wrapper's own process observe an fstat() failure on the open
    // descriptor for its own birth-time probe file, through the preload above
    // (PAP-5374). seq 1 is sessionDir's probe (the first one
    // captureSessionIdentity() runs).
    fstatFailure?: { seq: 1 | 2 };
  }) {
    const sessionDir = await mkdtemp(path.join(options?.parentDir ?? os.tmpdir(), "paperclip-wrapper-lifecycle-"));
    cleanupDirs.push(sessionDir);
    const stdinDir = path.join(sessionDir, "stdin");
    const eventsDir = path.join(sessionDir, "events");
    await mkdir(stdinDir, { recursive: true });
    if (options?.outputToStdout !== true) await mkdir(eventsDir, { recursive: true });

    const wrapperPath = path.join(sessionDir, "wrapper.mjs");
    await writeFile(wrapperPath, getProcessSessionRemoteSource({ outputToStdout: options?.outputToStdout === true }), "utf8");

    const config = { command: options?.command ?? "cat", args: options?.args ?? [], cwd: sessionDir, env: {} };
    const commandPayload = Buffer.from(JSON.stringify(config), "utf8").toString("base64");

    const env: Record<string, string> = {
      ...process.env,
      PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
      PAPERCLIP_PROCESS_SESSION_COMMAND_B64: commandPayload,
    };
    if (options?.maxRetries != null) env.PAPERCLIP_PROCESS_SESSION_STDIN_MAX_RETRIES = String(options.maxRetries);
    if (options?.terminateGraceMs != null) env.PAPERCLIP_PROCESS_SESSION_TERMINATE_GRACE_MS = String(options.terminateGraceMs);

    const execArgv: string[] = [];
    if (options?.fakeBirthtime) {
      env.PAPERCLIP_TEST_FAKE_BIRTHTIME_TARGET = options.fakeBirthtime.target;
      env.PAPERCLIP_TEST_FAKE_BIRTHTIME_MODE = options.fakeBirthtime.mode;
      execArgv.push("--require", await getFakeBirthtimePreloadPath());
    }
    if (options?.probeSwap) {
      env.PAPERCLIP_TEST_PROBE_SWAP_SEQ = String(options.probeSwap.seq);
      env.PAPERCLIP_TEST_PROBE_SWAP_MODE = options.probeSwap.mode;
      if (options.probeSwap.symlinkTarget) env.PAPERCLIP_TEST_PROBE_SWAP_SYMLINK_TARGET = options.probeSwap.symlinkTarget;
      execArgv.push("--require", await getProbeSwapPreloadPath());
    }
    if (options?.fstatFailure) {
      env.PAPERCLIP_TEST_FSTAT_FAILURE_SEQ = String(options.fstatFailure.seq);
      execArgv.push("--require", await getFstatFailurePreloadPath());
    }

    const child = spawn(process.execPath, [...execArgv, wrapperPath], {
      cwd: sessionDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const frames: WrapperFrame[] = [];
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line) as WrapperFrame);
        } catch {
          // A partial line at a chunk boundary; ignore.
        }
      }
    });
    let stderrText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const exited = new Promise<void>((resolve) => {
      child.on("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });

    async function readEventFiles(): Promise<WrapperFrame[]> {
      const names = (await readdir(eventsDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
      const out: WrapperFrame[] = [];
      for (const name of names) {
        const body = await readFile(path.join(eventsDir, name), "utf8").catch(() => "");
        if (!body.trim()) continue;
        try {
          out.push(JSON.parse(body) as WrapperFrame);
        } catch {
          // Not fully written yet; the test polls again.
        }
      }
      return out;
    }

    return {
      pid: child.pid,
      sessionDir,
      stdinDir,
      eventsDir,
      wrapperPath,
      frames,
      stderrText: () => stderrText,
      exited,
      exitInfo: () => ({ code: exitCode, signal: exitSignal }),
      readEventFiles,
    };
  }

  // A runner that runs each bridge shell script as a real child process
  // (matches the harness in the stdin-race describe block above), so a test
  // drives the whole legacy-poll bridge for real: the socket handler, the
  // command-managed `writeTextFile`/`remove` scripts, the nohup wrapper
  // launch, and the output poll.
  function createLocalSandboxRunner(onExecute?: (script: string) => Promise<void>) {
    let counter = 0;
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      }): Promise<RunProcessResult> => {
        counter += 1;
        const script = input.args?.[1] ?? "";
        if (onExecute) await onExecute(script);
        const command =
          input.command === "bash" ? "/bin/bash" : input.command === "sh" ? "/bin/sh" : input.command;
        return runChildProcess(`wrapper-lifecycle-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
        });
      },
    };
  }

  function trackedChildSource(pidFile: string): string {
    return [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `process.stdin.resume();`,
    ].join("\n");
  }

  // T2's child ignores SIGTERM, so `terminate()` must escalate to SIGKILL
  // after its grace period. Ignoring end-of-file on stdin alone would not
  // prove that: a plain `cat`-like child already dies from the default
  // SIGTERM disposition.
  function stubbornChildSource(pidFile: string): string {
    return [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `process.stdin.resume();`,
      `process.on("SIGTERM", () => {});`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
  }

  async function startTrackedBridgeSession(input: {
    rootDir: string;
    runId: string;
    childSource: string;
    runner: ReturnType<typeof createLocalSandboxRunner>;
  }) {
    const pidFile = path.join(input.rootDir, `${input.runId}.pid`);
    const childPath = path.join(input.rootDir, `${input.runId}-child.mjs`);
    await writeFile(childPath, input.childSource, "utf8");
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: input.rootDir,
      timeoutMs: 30_000,
      runner: input.runner,
    };
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: input.runId,
      target,
      runtimeRootDir: path.posix.join(input.rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: input.rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim().length > 0, 8_000);
    const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    return { bridge: bridge!, pid };
  }

  it("T1 exits within a bounded time when its session directory disappears with no message ever sent", async () => {
    const wrapper = await startWrapperProcess({ outputToStdout: false, terminateGraceMs: 200 });
    // Let the poll loop run a few cycles before the directory disappears.
    await delay(150);
    await rm(wrapper.sessionDir, { recursive: true, force: true });
    await Promise.race([
      wrapper.exited,
      delay(4_000).then(() => {
        throw new Error("The wrapper did not exit after its session directory disappeared.");
      }),
    ]);
  });

  it("T2 leaves neither the wrapper nor a stubborn child alive after stop()", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-stubborn-child-"));
    cleanupDirs.push(rootDir);
    const runner = createLocalSandboxRunner();
    const session = await startTrackedBridgeSession({
      rootDir,
      runId: "stubborn",
      childSource: stubbornChildSource(path.join(rootDir, "stubborn.pid")),
      runner,
    });
    // The emitted wrapper script's own path is unique to this test (it lives
    // under this test's fresh temp root), so a `ps` grep on it identifies
    // only this test's wrapper process, not a sibling test's.
    const wrapperScriptSubstring = path.posix.join(rootDir, ".paperclip-runtime", "acpx", "process-sessions");
    try {
      expect(isPidAlive(session.pid)).toBe(true);
      await waitFor(async () => (await findLivePidsByArgvSubstring(wrapperScriptSubstring)).length > 0, 4_000);
      await session.bridge.stop();
      // The child ignores SIGTERM, so `terminate()` needs its own grace
      // period (default 3s) before it escalates to SIGKILL.
      await waitFor(() => !isPidAlive(session.pid), 8_000);
      expect(isPidAlive(session.pid)).toBe(false);
      await waitFor(async () => (await findLivePidsByArgvSubstring(wrapperScriptSubstring)).length === 0, 4_000);
    } finally {
      await session.bridge.stop().catch(() => undefined);
    }
  }, 15_000);

  it("T3 exits on its own when the child exits first and no stdinEnd is ever sent", async () => {
    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await Promise.race([
      wrapper.exited,
      delay(4_000).then(() => {
        throw new Error("The wrapper did not exit on its own after its child exited.");
      }),
    ]);
    const events = await wrapper.readEventFiles();
    expect(events.some((event) => event.type === "exit")).toBe(true);
  });

  it("T4 stopping one session leaves a sibling session's wrapper and child alive", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-session-isolation-"));
    cleanupDirs.push(rootDir);
    const runner = createLocalSandboxRunner();
    const sessionA = await startTrackedBridgeSession({
      rootDir,
      runId: "session-a",
      childSource: trackedChildSource(path.join(rootDir, "session-a.pid")),
      runner,
    });
    const sessionB = await startTrackedBridgeSession({
      rootDir,
      runId: "session-b",
      childSource: trackedChildSource(path.join(rootDir, "session-b.pid")),
      runner,
    });
    try {
      expect(isPidAlive(sessionA.pid)).toBe(true);
      expect(isPidAlive(sessionB.pid)).toBe(true);

      await sessionA.bridge.stop();
      await waitFor(() => !isPidAlive(sessionA.pid), 8_000);

      expect(isPidAlive(sessionA.pid)).toBe(false);
      // Session B never received a stdinEnd or a shutdown message.
      expect(isPidAlive(sessionB.pid)).toBe(true);
    } finally {
      await sessionA.bridge.stop().catch(() => undefined);
      await sessionB.bridge.stop().catch(() => undefined);
    }
  }, 15_000);

  it("T5 still writes both control messages, finishes fast, and warns never after a forged exit event the live poll reads early", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-forged-exit-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "quiet-child.mjs");
    await writeFile(childPath, "process.stdin.resume();\n", "utf8");

    const scripts: string[] = [];
    const runner = createLocalSandboxRunner(async (script) => {
      scripts.push(script);
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };
    let warnedCount = 0;
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-forged-exit",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        if (stream === "stderr" && chunk.includes("did not acknowledge shutdown")) warnedCount += 1;
      },
    });
    expect(bridge).not.toBeNull();

    const mkdirScript = scripts.find((script) => script.startsWith("mkdir -p"));
    const dirsMatch = /mkdir -p '([^']+)' '([^']+)'/.exec(mkdirScript ?? "");
    expect(dirsMatch).not.toBeNull();
    const eventsDir = dirsMatch![2];

    // Forge an exit event from outside the wrapper, before any real shutdown.
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(eventsDir, "999999999999.json"), `${JSON.stringify({ type: "exit", code: 0 })}\n`, "utf8");

    // Give the live 100 ms host poll time to read the forged file well
    // before stop() runs. This closes the gap T5 used to leave open: a
    // forged event `stop()` observes only through its own bounded reader
    // (not through the live poll, which sets `stopping` on its own and
    // stops re-arming) must not shorten the wait either.
    await delay(600);

    scripts.length = 0;
    const start = Date.now();
    await bridge!.stop();
    const elapsedMs = Date.now() - start;

    const finalizeWrites = scripts.filter((script) => script.includes("base64 -d") && script.includes(".paperclip-upload.decoded"));
    // stdinEnd, then shutdown: both control messages still land.
    expect(finalizeWrites.length).toBeGreaterThanOrEqual(2);
    const removeScript = scripts.find((script) => script.trim().startsWith("rm -rf"));
    expect(removeScript).toBeDefined();
    // The child never exits on its own, so the wrapper's own genuine
    // shutdownAck -- not the forged exit event -- is the only thing that can
    // finish this fast with no warning. T14 (below) proves the forged event
    // alone gives no such shortcut when no genuine acknowledgement ever
    // follows it.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(warnedCount).toBe(0);
  }, 10_000);

  it("T14 a forged exit event alone does not shorten the wait when the wrapper never truly runs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-forged-only-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "quiet-child.mjs");
    await writeFile(childPath, "process.stdin.resume();\n", "utf8");

    const scripts: string[] = [];
    let counter = 0;
    // Run every script for real except the wrapper launch itself, so the
    // wrapper never starts. The forged file below is then the only event
    // that will ever exist under the session's events directory.
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      }): Promise<RunProcessResult> => {
        const script = input.args?.[1] ?? "";
        scripts.push(script);
        if (script.includes("nohup node")) {
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null };
        }
        counter += 1;
        const command =
          input.command === "bash" ? "/bin/bash" : input.command === "sh" ? "/bin/sh" : input.command;
        return runChildProcess(`forged-only-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
        });
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    let warnedCount = 0;
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-forged-only",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        if (stream === "stderr" && chunk.includes("did not acknowledge shutdown")) warnedCount += 1;
      },
    });
    expect(bridge).not.toBeNull();

    const mkdirScript = scripts.find((script) => script.startsWith("mkdir -p"));
    const dirsMatch = /mkdir -p '([^']+)' '([^']+)'/.exec(mkdirScript ?? "");
    expect(dirsMatch).not.toBeNull();
    const eventsDir = dirsMatch![2];

    // Forge a terminal event from outside the wrapper. The wrapper never
    // started, so this is the only event that will ever exist on disk.
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(eventsDir, "999999999999.json"), `${JSON.stringify({ type: "exit", code: 0 })}\n`, "utf8");

    // Give the live 100 ms host poll time to read the forged file well
    // before stop() runs, so this test cannot pass by accident: `stop()`
    // never itself observes this event through its own first-line
    // `stopping` flag.
    await delay(600);

    const start = Date.now();
    await bridge!.stop();
    const elapsedMs = Date.now() - start;

    // An exit event under `sessionDir` is untrusted telemetry. With no
    // genuine wrapper ever running to write a real shutdownAck, the wait
    // still runs its full budget and still warns, exactly as it would with
    // no forged event at all (compare T13).
    expect(elapsedMs).toBeGreaterThanOrEqual(2_900);
    expect(warnedCount).toBe(1);
    const removeScript = scripts.find((script) => script.trim().startsWith("rm -rf"));
    expect(removeScript).toBeDefined();
  }, 10_000);

  it("T6 issues no operating-system signal from the host during stop()", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-no-signal-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "quiet-child.mjs");
    await writeFile(childPath, "process.stdin.resume();\n", "utf8");

    const scripts: string[] = [];
    const runner = createLocalSandboxRunner(async (script) => {
      scripts.push(script);
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-no-signal",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    scripts.length = 0;
    await bridge!.stop();

    // stop() only ever writes files and removes a directory. None of the
    // scripts it runs names a signal or a kill command.
    const signalLike = scripts.filter((script) => /\bkill\b|SIGTERM|SIGKILL/i.test(script));
    expect(signalLike).toEqual([]);
  });

  it("T8 running terminate() a second time, after the child already exited, is a safe no-op", async () => {
    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await Promise.race([
      wrapper.exited,
      delay(4_000).then(() => {
        throw new Error("The wrapper did not exit after its child exited on its own.");
      }),
    ]);
    // The wrapper's own child-close handler already ran terminate() once (the
    // child was already gone, so its child.kill() call no-opped). The
    // wrapper did not throw and did not hang.
    expect(wrapper.stderrText()).toBe("");
    expect(wrapper.exitInfo().code).toBe(0);
    const events = await wrapper.readEventFiles();
    expect(events.filter((event) => event.type === "exit").length).toBe(1);
    // No stray signal-triggered event (e.g. a second exit from a SIGKILL)
    // ever landed.
    expect(events.filter((event) => event.type === "error").length).toBe(0);
  });

  it("T9 exits with an error event when sessionDir is a symbolic link", async () => {
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-symlink-target-"));
    cleanupDirs.push(targetDir);
    const linkDir = `${targetDir}-link`;
    const { symlink } = await import("node:fs/promises");
    await symlink(targetDir, linkDir, "dir");
    cleanupDirs.push(linkDir);

    const wrapperPath = path.join(targetDir, "wrapper.mjs");
    await writeFile(wrapperPath, getProcessSessionRemoteSource({ outputToStdout: true }), "utf8");
    const config = { command: "cat", args: [] as string[], cwd: targetDir, env: {} };
    const commandPayload = Buffer.from(JSON.stringify(config), "utf8").toString("base64");

    const child = spawn(process.execPath, [wrapperPath], {
      cwd: targetDir,
      env: {
        ...process.env,
        PAPERCLIP_PROCESS_SESSION_DIR: linkDir,
        PAPERCLIP_PROCESS_SESSION_COMMAND_B64: commandPayload,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const frames: WrapperFrame[] = [];
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        frames.push(JSON.parse(line) as WrapperFrame);
      }
    });
    const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));

    await Promise.race([
      exited,
      delay(4_000).then(() => {
        throw new Error("The wrapper did not exit after sessionDir was a symbolic link.");
      }),
    ]);
    expect(frames.some((frame) => frame.type === "error" && typeof frame.message === "string" && frame.message.includes("symbolic link"))).toBe(
      true,
    );
  });

  it("T10 the emitted wrapper strips its own session env vars from the child", async () => {
    const wrapper = await startWrapperProcess({
      outputToStdout: true,
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('PAPERCLIP_PROCESS_SESSION'))));process.exit(0)",
      ],
    });
    await waitFor(() => wrapper.frames.some((frame) => frame.type === "exit"), 4_000);
    const text = wrapper.frames
      .filter((frame) => frame.type === "data" && frame.stream === "stdout" && typeof frame.data === "string")
      .map((frame) => Buffer.from(frame.data as string, "base64").toString("utf8"))
      .join("");
    const leakedKeys = JSON.parse(text || "[]") as string[];
    expect(leakedKeys).toEqual([]);
  });

  it("T11 each wrapper source has exactly one spawn call site and every kill call is child.kill()", () => {
    for (const outputToStdout of [true, false]) {
      const src = getProcessSessionRemoteSource({ outputToStdout });
      // Strip `//` line comments first, so prose that happens to mention
      // "spawn(" or "kill(" (e.g. explaining `ChildProcess#kill()`) is never
      // mistaken for a call site. This checks the code, not the comments.
      const code = src
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      const spawnCallSites = code.match(/\bspawn\(/g) ?? [];
      expect(spawnCallSites.length).toBe(1);
      const killCallSites = [...code.matchAll(/[A-Za-z0-9_.$]*kill\(/g)].map((match) => match[0]);
      expect(killCallSites.length).toBeGreaterThan(0);
      for (const site of killCallSites) {
        expect(site).toBe("child.kill(");
      }

      // Regression coverage for PAP-5336: the shared tail must carry the
      // session-identity latch, not the old counter it replaced. A counter
      // that a successful `readdir` reset to zero let an attacker who
      // recreated a deleted control directory keep the wrapper alive
      // forever. Both wrapper variants append the same shared tail, so this
      // check runs once per variant and fails if a future edit lands the
      // latch in only one of them.
      expect(src).not.toContain("missingSessionDirStreak");
      const identityLatchDeclarations = code.match(/\blet identityLost = false;/g) ?? [];
      expect(identityLatchDeclarations.length).toBe(1);
      const identityCaptureCallSites = code.match(/\bcaptureSessionIdentity\(\)/g) ?? [];
      expect(identityCaptureCallSites.length).toBeGreaterThan(0);
      const identityVerifyCallSites = code.match(/\bverifySessionIdentity\(\)/g) ?? [];
      expect(identityVerifyCallSites.length).toBeGreaterThan(0);
      // The capture must run before the first poll cycle: its call site must
      // precede the `pollStdin()` call site in the emitted source.
      expect(code.indexOf("await captureSessionIdentity();")).toBeGreaterThan(0);
      expect(code.indexOf("await captureSessionIdentity();")).toBeLessThan(code.indexOf("void pollStdin()"));
    }
  });

  // Regression coverage for PAP-5323: the host used to burn the full
  // shutdown budget and log a false warning on every normal run, because
  // the file-poll loop stopped re-arming right after it delivered the
  // `exit` event and so never read the `shutdownAck` file that followed it.
  it("T12 stop() finishes well inside the shutdown budget and logs no warning after a normal child exit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-normal-exit-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "quick-exit-child.mjs");
    await writeFile(childPath, "process.exit(0);\n", "utf8");

    const runner = createLocalSandboxRunner();
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    let warnedCount = 0;
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-normal-exit",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        if (stream === "stderr" && chunk.includes("did not acknowledge shutdown")) warnedCount += 1;
      },
    });
    expect(bridge).not.toBeNull();

    // Let the child exit and the wrapper write its own `exit` event before
    // stop() runs, so this matches a normal run-completion teardown.
    await delay(500);

    const start = Date.now();
    await bridge!.stop();
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(warnedCount).toBe(0);
  }, 10_000);

  // Regression coverage for PAP-5323: a genuinely stuck wrapper, one that
  // never writes any event, must still warn after the budget and still
  // remove `sessionDir`. The fix must not turn the bounded wait into an
  // unconditional skip.
  it("T13 warns and still removes sessionDir when the wrapper never acknowledges and never exits", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-never-acks-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "quiet-child.mjs");
    await writeFile(childPath, "process.stdin.resume();\n", "utf8");

    const scripts: string[] = [];
    let counter = 0;
    // Run every script for real except the wrapper launch itself, so the
    // wrapper never starts and the events directory stays empty on every
    // poll. `stop()` can then never observe a real `shutdownAck` or a real
    // terminal `exit`/`error` event.
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      }): Promise<RunProcessResult> => {
        const script = input.args?.[1] ?? "";
        scripts.push(script);
        if (script.includes("nohup node")) {
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null };
        }
        counter += 1;
        const command =
          input.command === "bash" ? "/bin/bash" : input.command === "sh" ? "/bin/sh" : input.command;
        return runChildProcess(`never-acks-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
        });
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    let warnedCount = 0;
    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-never-acks",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        if (stream === "stderr" && chunk.includes("did not acknowledge shutdown")) warnedCount += 1;
      },
    });
    expect(bridge).not.toBeNull();

    const start = Date.now();
    await bridge!.stop();
    const elapsedMs = Date.now() - start;

    // The full shutdown budget elapsed, because nothing ever proved the
    // wrapper stopped.
    expect(elapsedMs).toBeGreaterThanOrEqual(2_900);
    expect(warnedCount).toBe(1);
    const removeScript = scripts.find((script) => script.trim().startsWith("rm -rf"));
    expect(removeScript).toBeDefined();
  }, 10_000);

  // Regression coverage for PAP-5336: the finding this test reproduces is a
  // sandbox control-plane integrity failure, not a timing quirk. During
  // `stop()`, a sandbox peer with access to the session directory can (1)
  // delete the real `shutdown` control file before the wrapper ever reads
  // it, (2) forge a `shutdownAck` event so the host's wait ends early, and
  // (3) recreate `sessionDir/stdin` right after the host removes
  // `sessionDir`. On the parent commit, a successful `readdir` on the
  // recreated directory reset the wrapper's only terminal counter to zero,
  // so the wrapper (and its child) polled forever.
  //
  // The fix replaces the counter with an identity captured at startup: the
  // device number, the inode number, and the inode's own creation time. All
  // three matter for this test to be a real regression check, not a check
  // that passes by luck. Recreating a directory at the same path right after
  // removal, with nothing else on the filesystem in between, can reissue the
  // exact same device and inode numbers on common filesystems (this test's
  // recreate step does exactly that): a device/inode-only identity would
  // then wrongly read as unchanged. The creation time does not have this
  // gap, because it is set fresh on every inode allocation even when the
  // allocator reissues an old inode number.
  it("T15 latches on a lost session identity: a recreated control directory cannot keep the wrapper or its child alive", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lost-identity-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t15-child.pid");
    const childPath = path.join(rootDir, "t15-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    let sessionDir = "";
    let stdinDir = "";
    let eventsDir = "";
    let shutdownFileDeleted = false;
    let shutdownAckForged = false;
    let stdinDirRecreated = false;
    const scripts: string[] = [];
    let counter = 0;

    const syntheticSuccess: RunProcessResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    };

    // Run every script for real on the local filesystem (matching T2/T4/T5's
    // harness), so a real wrapper process and a real child process come up,
    // with two exceptions that make the attack deterministic instead of a
    // race against the wrapper's own 50 ms poll:
    //
    // 1. With no stdin data ever sent, the host's shutdown control message
    //    always targets stdin file 000000000002.json (file 1 is stdinEnd).
    //    Never let that write's script pipeline actually run: this is
    //    equivalent to an attacker who deletes the file before the wrapper
    //    ever reads it, but with no window in which the wrapper could win a
    //    race and read it first.
    // 2. Perform the sessionDir removal and the sessionDir/stdin,
    //    sessionDir/events recreation as direct filesystem calls in this
    //    same async step, instead of spawning a real `rm -rf` subprocess.
    //    That removes an external process's scheduling latency from the
    //    window the wrapper's next poll cycle has to observe the recreated
    //    directory.
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      }): Promise<RunProcessResult> => {
        counter += 1;
        const script = input.args?.[1] ?? "";
        scripts.push(script);

        const shutdownFilePath = stdinDir ? path.posix.join(stdinDir, "000000000002.json") : null;
        if (shutdownFilePath && script.includes(shutdownFilePath)) {
          if (!shutdownFileDeleted) {
            shutdownFileDeleted = true;
            await writeFile(
              path.join(eventsDir, "999999999999.json"),
              `${JSON.stringify({ type: "shutdownAck" })}\n`,
              "utf8",
            ).catch(() => undefined);
            shutdownAckForged = true;
          }
          return syntheticSuccess;
        }

        // Match the removal of sessionDir itself, not the host's own
        // per-file event cleanup (which also runs `rm -rf` on a path that
        // has sessionDir as a substring).
        if (!stdinDirRecreated && sessionDir && script.trim() === `rm -rf '${sessionDir}'`) {
          stdinDirRecreated = true;
          await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
          await mkdir(stdinDir, { recursive: true }).catch(() => undefined);
          await mkdir(eventsDir, { recursive: true }).catch(() => undefined);
          return syntheticSuccess;
        }

        const command =
          input.command === "bash" ? "/bin/bash" : input.command === "sh" ? "/bin/sh" : input.command;
        return runChildProcess(`lost-identity-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
        });
      },
    };

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-lost-identity",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    const mkdirScript = scripts.find((script) => script.startsWith("mkdir -p"));
    const dirsMatch = /mkdir -p '([^']+)' '([^']+)'/.exec(mkdirScript ?? "");
    expect(dirsMatch).not.toBeNull();
    stdinDir = dirsMatch![1];
    eventsDir = dirsMatch![2];
    sessionDir = path.posix.dirname(stdinDir);

    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim().length > 0, 8_000);
    const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    expect(isPidAlive(pid)).toBe(true);
    const wrapperScriptSubstring = path.posix.join(rootDir, ".paperclip-runtime", "acpx", "process-sessions");
    await waitFor(async () => (await findLivePidsByArgvSubstring(wrapperScriptSubstring)).length > 0, 4_000);

    await bridge!.stop();

    // Both the attacker's forged shutdownAck and its directory recreation
    // ran; this is the full chain the finding describes, not a partial one.
    expect(shutdownFileDeleted).toBe(true);
    expect(shutdownAckForged).toBe(true);
    expect(stdinDirRecreated).toBe(true);

    // The wrapper process and its child process both exit within a bounded
    // time, even though the wrapper never read a real shutdown message and
    // the host's wait ended early on a forged hint. Only the wrapper's own
    // identity latch can explain this: it observes the recreated directory
    // carries a different identity than the one captured at startup.
    await waitFor(() => !isPidAlive(pid), 8_000);
    expect(isPidAlive(pid)).toBe(false);
    await waitFor(async () => (await findLivePidsByArgvSubstring(wrapperScriptSubstring)).length === 0, 8_000);
  }, 15_000);

  // ---- PAP-5338: reject a change-time creation-time substitute, and every
  // lstat error during verification -------------------------------------

  async function waitForTrackedChildPid(pidFile: string): Promise<number> {
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim().length > 0, 8_000);
    return Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  }

  async function expectWrapperAndTrackedChildToDie(
    wrapper: { exited: Promise<void> },
    pid: number,
  ): Promise<void> {
    await waitFor(() => !isPidAlive(pid), 8_000);
    expect(isPidAlive(pid)).toBe(false);
    await Promise.race([
      wrapper.exited,
      delay(8_000).then(() => {
        throw new Error("The wrapper process did not exit.");
      }),
    ]);
  }

  // A capture failure latches and calls terminate() before the poll loop
  // ever starts, often within a few milliseconds of the child's own spawn()
  // call returning. A freshly spawned Node.js child needs real wall-clock
  // time just to boot before it can run its own code, so it can lose the
  // race to write a pid file before terminate()'s SIGTERM reaches it. The
  // change-time fallback test below therefore proves death through the OS
  // process table by the child's own script path (the same technique T15
  // above uses for the wrapper itself), which needs no cooperation from code
  // inside the child.
  async function expectNoLiveProcessByArgvSubstring(substring: string): Promise<void> {
    await waitFor(async () => (await findLivePidsByArgvSubstring(substring)).length === 0, 8_000);
    expect(await findLivePidsByArgvSubstring(substring)).toEqual([]);
  }

  it("T16 accepts a zero creation time when the filesystem does not report birth time", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-birthtime-zero-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t16-child.pid");
    const childPath = path.join(rootDir, "t16-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
      fakeBirthtime: { target: "sessionDir", mode: "zero" },
    });

    const pid = await waitForTrackedChildPid(pidFile);
    expect(isPidAlive(pid)).toBe(true);
    await writeFile(
      path.join(wrapper.stdinDir, "000000000001.json"),
      `${JSON.stringify({ type: "stdinEnd" })}\n`,
      "utf8",
    );
    await Promise.race([
      wrapper.exited,
      delay(8_000).then(() => {
        throw new Error("The wrapper process did not exit.");
      }),
    ]);
    expect(wrapper.exitInfo().code).toBe(0);
    expect(wrapper.stderrText()).not.toMatch(/not usable/);
  }, 15_000);

  it("T17 fails closed at capture when the reported creation time follows the change time, so a change-time copy never passes as a real creation time", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-birthtime-followctime-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t17-child.pid");
    const childPath = path.join(rootDir, "t17-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
      fakeBirthtime: { target: "stdinDir", mode: "followCtime" },
    });

    await Promise.race([
      wrapper.exited,
      delay(8_000).then(() => {
        throw new Error("The wrapper process did not exit.");
      }),
    ]);
    await expectNoLiveProcessByArgvSubstring(childPath);
    expect(wrapper.stderrText()).toMatch(/changed after a probe write/);
  }, 15_000);

  it("T18 latches on an EACCES lstat failure on sessionDir during verification, not only on a removed directory", async () => {
    // sessionDir lives inside a parent this test owns, never the shared OS
    // temp directory: the test denies traversal on that parent, and doing
    // that to the shared OS temp directory would break every other process
    // on the host that also uses it.
    const parentDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-eacces-sessiondir-"));
    cleanupDirs.push(parentDir);
    const pidFile = path.join(parentDir, "t18-child.pid");
    const childPath = path.join(parentDir, "t18-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
      parentDir,
      terminateGraceMs: 200,
    });

    const pid = await waitForTrackedChildPid(pidFile);
    // Let capture succeed and the poll loop run a clean cycle first, so the
    // termination below proves the verify-time latch, not the capture-time
    // one.
    await delay(150);
    await chmod(parentDir, 0o000);
    try {
      await expectWrapperAndTrackedChildToDie(wrapper, pid);
    } finally {
      // Restore permission so the shared cleanup can remove this directory.
      await chmod(parentDir, 0o700).catch(() => undefined);
    }
    expect(wrapper.stderrText()).toMatch(/Latching on a lost process session identity/);
  }, 15_000);

  it("T19 latches on an EACCES lstat failure on stdinDir during verification, even though sessionDir itself still stats cleanly", async () => {
    const wrapperOptions = { outputToStdout: false as const, terminateGraceMs: 200 };
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-eacces-stdindir-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t19-child.pid");
    const childPath = path.join(rootDir, "t19-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({ ...wrapperOptions, command: process.execPath, args: [childPath] });

    const pid = await waitForTrackedChildPid(pidFile);
    await delay(150);
    // Deny traversal into sessionDir itself: lstat(stdinDir) fails EACCES
    // while lstat(sessionDir) still succeeds, since a directory's own mode
    // never gates lstat of the directory itself, only lookups inside it.
    await chmod(wrapper.sessionDir, 0o000);
    try {
      await expectWrapperAndTrackedChildToDie(wrapper, pid);
    } finally {
      await chmod(wrapper.sessionDir, 0o700).catch(() => undefined);
    }
    expect(wrapper.stderrText()).toMatch(/Latching on a lost process session identity/);
  }, 15_000);

  it("T20 refuses to write through a probe path a sandbox peer pre-created as a symbolic link, and leaves that link and its target untouched", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-symlink-race-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t20-child.pid");
    const childPath = path.join(rootDir, "t20-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-symlink-session-"));
    cleanupDirs.push(sessionDir);
    const stdinDir = path.join(sessionDir, "stdin");
    await mkdir(stdinDir, { recursive: true });

    const wrapperPath = path.join(sessionDir, "wrapper.mjs");
    await writeFile(wrapperPath, getProcessSessionRemoteSource({ outputToStdout: true }), "utf8");
    const config = { command: process.execPath, args: [childPath], cwd: sessionDir, env: {} };
    const commandPayload = Buffer.from(JSON.stringify(config), "utf8").toString("base64");

    // A file this test owns, standing in for a file a sandbox peer already
    // controls. The wrapper's probe write must never reach it.
    const probeLinkTarget = path.join(rootDir, "t20-probe-target.txt");
    const knownContent = "t20-untouched-content";
    await writeFile(probeLinkTarget, knownContent, "utf8");

    const child = spawn(process.execPath, [wrapperPath], {
      cwd: sessionDir,
      env: {
        ...process.env,
        PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
        PAPERCLIP_PROCESS_SESSION_COMMAND_B64: commandPayload,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wins the race to the probe path against the wrapper's own probe write.
    // nextProbeFileName() is deterministic: it names
    // ".paperclip-birthtime-probe-<pid>-1" on the wrapper's first probe call,
    // which always targets sessionDir. child.pid is available synchronously
    // right after spawn() returns, well before the freshly spawned process
    // has loaded Node or parsed its own script, so this synchronous
    // symlinkSync call lands first. This is the same advantage a real
    // sandbox peer racing to pre-create the path would have, so it gives the
    // strongest proof: the real wrapper process, under the real race, must
    // still refuse to follow the link.
    const probePath = path.join(sessionDir, `.paperclip-birthtime-probe-${child.pid}-1`);
    symlinkSync(probeLinkTarget, probePath);

    let stderrText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));

    await Promise.race([
      exited,
      delay(8_000).then(() => {
        throw new Error("The wrapper process did not exit.");
      }),
    ]);

    await expectNoLiveProcessByArgvSubstring(childPath);
    expect(stderrText).toMatch(/could not be created exclusively/);
    expect((await lstat(probePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(probeLinkTarget, "utf8")).toBe(knownContent);
  }, 15_000);

  // ---- PAP-5355: identity-aware cleanup after a same-sandbox peer replaces
  // the probe file this wrapper just created, in the gap between this
  // wrapper's last identity check and its removal call. The probeSwap
  // preload (see getProbeSwapPreloadPath above) simulates the worst-case
  // timing for that gap deterministically, instead of racing real wall-clock
  // time: it swaps the path the instant the wrapper itself looks at it for
  // the last time before deciding whether to remove it.

  it("T21 still removes its own probe file normally when no peer ever replaces it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-no-swap-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t21-child.pid");
    const childPath = path.join(rootDir, "t21-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
    });
    await waitForTrackedChildPid(pidFile);

    const probePath = path.join(wrapper.sessionDir, `.paperclip-birthtime-probe-${wrapper.pid}-1`);
    await waitFor(async () => !(await lstat(probePath).then(() => true).catch(() => false)), 4_000);
    await expect(lstat(probePath)).rejects.toThrow();
  }, 15_000);

  it("T22 leaves a peer's replacement file untouched instead of deleting it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-swap-file-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t22-child.pid");
    const childPath = path.join(rootDir, "t22-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
      probeSwap: { seq: 1, mode: "file" },
    });
    await waitForTrackedChildPid(pidFile);

    const probePath = path.join(wrapper.sessionDir, `.paperclip-birthtime-probe-${wrapper.pid}-1`);
    await waitFor(async () => (await readFile(probePath, "utf8").catch(() => null)) === "peer-owned-content", 4_000);
    // The wrapper's own cleanup call already ran (the preload only swaps the
    // path the moment the wrapper itself checks it). This delay proves that
    // run settled and nothing removes the peer's file afterward.
    await delay(200);
    expect(await readFile(probePath, "utf8")).toBe("peer-owned-content");
  }, 15_000);

  it("T23 leaves a peer's replacement directory untouched instead of deleting it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-swap-dir-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t23-child.pid");
    const childPath = path.join(rootDir, "t23-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
      probeSwap: { seq: 1, mode: "dir" },
    });
    await waitForTrackedChildPid(pidFile);

    const probePath = path.join(wrapper.sessionDir, `.paperclip-birthtime-probe-${wrapper.pid}-1`);
    await waitFor(async () => await lstat(probePath).then((stats) => stats.isDirectory()).catch(() => false), 4_000);
    await delay(200);
    expect((await lstat(probePath)).isDirectory()).toBe(true);
  }, 15_000);

  it("T24 leaves a peer's replacement symbolic link and its target untouched instead of deleting or following it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-swap-symlink-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t24-child.pid");
    const childPath = path.join(rootDir, "t24-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const linkTarget = path.join(rootDir, "t24-probe-target.txt");
    const knownContent = "t24-untouched-content";
    await writeFile(linkTarget, knownContent, "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
      probeSwap: { seq: 1, mode: "symlink", symlinkTarget: linkTarget },
    });
    await waitForTrackedChildPid(pidFile);

    const probePath = path.join(wrapper.sessionDir, `.paperclip-birthtime-probe-${wrapper.pid}-1`);
    await waitFor(async () => await lstat(probePath).then((stats) => stats.isSymbolicLink()).catch(() => false), 4_000);
    await delay(200);
    expect((await lstat(probePath)).isSymbolicLink()).toBe(true);
    expect(await readlink(probePath)).toBe(linkTarget);
    expect(await readFile(linkTarget, "utf8")).toBe(knownContent);
  }, 15_000);

  it("T25 fails closed at capture when its own probe file's identity cannot be read, so no orphan wrapper or child ever starts polling", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-fstat-failure-"));
    cleanupDirs.push(rootDir);
    const pidFile = path.join(rootDir, "t25-child.pid");
    const childPath = path.join(rootDir, "t25-child.mjs");
    await writeFile(childPath, trackedChildSource(pidFile), "utf8");

    const wrapper = await startWrapperProcess({
      outputToStdout: false,
      command: process.execPath,
      args: [childPath],
      fstatFailure: { seq: 1 },
    });

    await Promise.race([
      wrapper.exited,
      delay(8_000).then(() => {
        throw new Error("The wrapper process did not exit.");
      }),
    ]);
    expect(wrapper.stderrText()).toMatch(/its own probe file's identity could not be read/);
    await expectNoLiveProcessByArgvSubstring(childPath);

    // With no verified identity for the probe file, the wrapper must not
    // remove it by path alone: it leaves the file exactly as it created it,
    // rather than risking removal of a different entry a peer may have put
    // at the same path.
    const probePath = path.join(wrapper.sessionDir, `.paperclip-birthtime-probe-${wrapper.pid}-1`);
    expect((await lstat(probePath)).isFile()).toBe(true);
  }, 15_000);
});
