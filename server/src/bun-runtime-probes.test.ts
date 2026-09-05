import { describe, expect, test } from "bun:test";
import { finalizeServerShutdown } from "./shutdown.ts";

const sleepCommand = process.platform === "win32" ? ["cmd", "/c", "ping", "-n", "6", "127.0.0.1"] : ["sleep", "5"];

describe("Bun runtime compatibility probes", () => {
  test("pipes stdin to stdout and exposes the real exit status", async () => {
    const processHandle = Bun.spawn({
      cmd: ["cat"],
      stdin: new ReadableStream({
        start(controller) {
          controller.enqueue("bun-runtime-probe");
          controller.close();
        },
      }),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await processHandle.stdout.text()).toBe("bun-runtime-probe");
    expect(await processHandle.exited).toBe(0);
  });

  test("terminates a real child process with AbortSignal and settles exited", async () => {
    const controller = new AbortController();
    const processHandle = Bun.spawn({
      cmd: sleepCommand,
      signal: controller.signal,
      killSignal: "SIGTERM",
      stdout: "ignore",
      stderr: "ignore",
    });

    controller.abort();
    const exitCode = await processHandle.exited;
    expect(exitCode).not.toBe(0);
  });

  test("terminates a real child process after timeout", async () => {
    const processHandle = Bun.spawn({
      cmd: sleepCommand,
      timeout: 25,
      killSignal: "SIGTERM",
      stdout: "ignore",
      stderr: "ignore",
    });

    const exitCode = await processHandle.exited;
    expect(exitCode).not.toBe(0);
  });

  test("preserves shutdown ordering with optional database and observability stages", async () => {
    const order: string[] = [];
    const logger = {
      info: () => undefined,
      error: () => undefined,
    };

    await finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices: async () => order.push("app"),
      stopEmbeddedPostgres: null,
      shutdownInstrumentation: async () => order.push("otel"),
      shutdownSentry: async () => order.push("sentry"),
      log: logger,
    });

    expect(order).toEqual(["app", "otel", "sentry"]);
  });
});
