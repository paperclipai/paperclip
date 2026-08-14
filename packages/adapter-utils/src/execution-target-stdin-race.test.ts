import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { getProcessSessionRemoteSource } from "./execution-target.js";
import { createCommandManagedSandboxCallbackBridgeQueueClient } from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

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
