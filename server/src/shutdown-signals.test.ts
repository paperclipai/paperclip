import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCoordinatedShutdown } from "./shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createCoordinatedShutdown", () => {
  it("keeps a listener on each signal while the shutdown runs, so a repeated signal joins it", async () => {
    const signals = new EventEmitter();
    const teardown = deferred();
    const performShutdown = vi.fn(() => teardown.promise);
    createCoordinatedShutdown(performShutdown, signals);

    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    signals.emit("SIGINT");

    expect(performShutdown).toHaveBeenCalledTimes(1);
    expect(performShutdown).toHaveBeenCalledWith("SIGTERM", true);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);

    teardown.resolve();
    await teardown.promise;
  });

  it("joins a signal to an in-process shutdown that is already running", async () => {
    const signals = new EventEmitter();
    const teardown = deferred();
    const performShutdown = vi.fn(() => teardown.promise);
    const shutdown = createCoordinatedShutdown(performShutdown, signals);

    const inProcess = shutdown("SIGTERM", false);
    signals.emit("SIGINT");
    signals.emit("SIGINT");

    expect(performShutdown).toHaveBeenCalledTimes(1);
    expect(performShutdown).toHaveBeenCalledWith("SIGTERM", false);
    expect(shutdown("SIGINT", true)).toBe(inProcess);

    teardown.resolve();
    await inProcess;
  });

  it("gives the signals back after an in-process shutdown finishes", async () => {
    const signals = new EventEmitter();
    const shutdown = createCoordinatedShutdown(async () => {}, signals);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);

    await shutdown("SIGTERM", false);

    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("finishes the teardown when a real process receives SIGTERM twice", async () => {
    const shutdownPath = fileURLToPath(new URL("./shutdown.ts", import.meta.url));
    const tsx = createRequire(import.meta.url).resolve("tsx/esm");
    const script = [
      `import { createCoordinatedShutdown } from ${JSON.stringify(shutdownPath)};`,
      "createCoordinatedShutdown(async () => {",
      "  await new Promise((resolve) => setTimeout(resolve, 300));",
      "  console.log('teardown finished');",
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1_000);",
      "console.log('ready');",
    ].join("\n");
    const child = spawn(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const waitingForReady = !stdout.includes("ready");
      stdout += chunk;
      if (waitingForReady && stdout.includes("ready")) {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGTERM"), 50);
      }
    });

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("teardown finished");
  }, 30_000);
});
