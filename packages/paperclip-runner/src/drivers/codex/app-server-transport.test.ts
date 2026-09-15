import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { createSanitizedCodexEnvironment, ProcessCodexAppServerTransport, redactCodexDiagnostic } from "./app-server-transport.js";

function nodeTransport(
  source: string,
  options: ConstructorParameters<typeof ProcessCodexAppServerTransport>[0] = {},
) {
  return new ProcessCodexAppServerTransport({
    ...options,
    command: process.execPath,
    args: ["-e", source],
    environment: { PATH: process.env.PATH },
  });
}

describe("Codex app-server transport limits", () => {
  it("passes only bounded controller-projected GitHub credentials", () => {
    expect(
      createSanitizedCodexEnvironment({
        PATH: "/safe/bin",
        GH_TOKEN: "github-token",
        PAPERCLIP_GIT_TOKEN: "github-token",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "!trusted-helper",
        GIT_CONFIG_KEY_1: "must.not.cross",
        GIT_CONFIG_VALUE_1: "must-not-cross",
        PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
        DATABASE_URL: "must-not-cross",
      }),
    ).toEqual({
      PATH: "/safe/bin",
      GH_TOKEN: "github-token",
      PAPERCLIP_GIT_TOKEN: "github-token",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!trusted-helper",
      PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
    });

    const invalid = createSanitizedCodexEnvironment({
      GH_TOKEN: "github-token",
      GIT_CONFIG_COUNT: "33",
      GIT_CONFIG_KEY_0: "must.not.cross",
    });
    expect(invalid.GH_TOKEN).toBe("github-token");
    expect(invalid.GIT_CONFIG_COUNT).toBeUndefined();
    expect(invalid.GIT_CONFIG_KEY_0).toBeUndefined();
  });

  it("redacts real Basic credentials without corrupting ordinary question copy", () => {
    expect(redactCodexDiagnostic("Authorization: Basic dXNlcjpwYXNz"))
      .toBe("Authorization: Basic [REDACTED]");
    expect(redactCodexDiagnostic("Basic API foundation"))
      .toBe("Basic API foundation");
  });

  it("reports restart-safe process-group ownership", async () => {
    const transport = nodeTransport("process.stdin.resume()", { processGroup: true });
    const info = transport.processInfo();

    expect(info.pid).toBeGreaterThan(0);
    expect(info.processGroupId).toBe(process.platform === "win32" ? null : info.pid);
    expect(new Date(info.startedAt).toISOString()).toBe(info.startedAt);

    await transport.close();
  });

  it("installs cleanup handlers before synchronously reporting process ownership", async () => {
    const originalSpawn = ChildProcess.prototype.spawn;
    let spawnedProcess: ChildProcess | undefined;
    const spawnSpy = vi
      .spyOn(ChildProcess.prototype, "spawn")
      .mockImplementation(function (this: ChildProcess, ...args) {
        spawnedProcess = this;
        return originalSpawn.apply(this, args);
      });
    let transport: ProcessCodexAppServerTransport | undefined;
    let observedInitialProcess = false;

    try {
      transport = nodeTransport("process.stdin.resume()", {
        onProcess: (info) => {
          if (info.exited) return;
          observedInitialProcess = true;
          expect(spawnedProcess?.pid).toBe(info.pid);
          expect(spawnedProcess?.listenerCount("error")).toBeGreaterThan(0);
          expect(spawnedProcess?.listenerCount("exit")).toBeGreaterThan(0);
          expect(
            spawnedProcess?.stdout?.listenerCount("data"),
          ).toBeGreaterThan(0);
          expect(
            spawnedProcess?.stdout?.listenerCount("end"),
          ).toBeGreaterThan(0);
          expect(
            spawnedProcess?.stderr?.listenerCount("data"),
          ).toBeGreaterThan(0);
          expect(
            spawnedProcess?.stdin?.listenerCount("error"),
          ).toBeGreaterThan(0);
          spawnedProcess?.emit(
            "error",
            new Error("synchronous process callback cleanup"),
          );
        },
      });
      expect(observedInitialProcess).toBe(true);
      await expect(
        transport.request("after-callback-cleanup", {}),
      ).rejects.toThrow("codex app-server transport is closed");
    } finally {
      spawnSpy.mockRestore();
      await transport?.close();
    }
  });

  it("rejects an oversized line before buffering the complete hostile payload", async () => {
    const diagnostics: string[] = [];
    const transport = nodeTransport(
      "setTimeout(() => process.stdout.write('x'.repeat(1048576)), 50); setInterval(() => {}, 1000)",
      { maxLineBytes: 128, onDiagnostic: (message) => diagnostics.push(message) },
    );
    await expect(transport.notifications()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "codex app-server line exceeded 128 bytes",
    );
    expect(diagnostics).toEqual(["codex app-server line exceeded 128 bytes"]);
    await transport.close();
  });

  it("bounds pending requests", async () => {
    const transport = nodeTransport("process.stdin.resume()", { maxPendingRequests: 1 });
    const first = transport.request("first", {});
    await expect(transport.request("second", {})).rejects.toThrow(
      "codex app-server pending request limit 1 exceeded",
    );
    const firstRejected = expect(first).rejects.toThrow("codex app-server transport closed");
    await transport.close();
    await firstRejected;
  });

  it("fails closed when queued notifications exceed their count bound", async () => {
    let transport: ProcessCodexAppServerTransport;
    const diagnostic = new Promise<string>((resolve) => {
      const lines = [1, 2].map((id) => JSON.stringify({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item: { id } },
      })).join("\n");
      transport = nodeTransport(
        `setTimeout(() => process.stdout.write(${JSON.stringify(`${lines}\n`)}), 50); setInterval(() => {}, 1000)`,
        {
          maxQueuedNotifications: 1,
          maxQueuedNotificationBytes: 1024,
          onDiagnostic: (message) => resolve(message),
        },
      );
    });
    await expect(diagnostic).resolves.toBe("codex app-server notification queue limit exceeded");
    await transport!.close();
  });

  it("rejects malformed JSON-RPC messages", async () => {
    const transport = nodeTransport(
      "setTimeout(() => process.stdout.write('{not-json}\\n'), 50); setInterval(() => {}, 1000)",
    );
    await expect(transport.request("pending", {})).rejects.toThrow(
      "codex app-server emitted malformed JSON",
    );
    await transport.close();
  });

  it("fails pending and future requests when stdout closes cleanly", async () => {
    const transport = nodeTransport(
      "process.stdin.resume(); process.stdout.end(); setInterval(() => {}, 1000)",
    );
    const pending = transport.request("pending", {});
    await expect(pending).rejects.toThrow(
      "codex app-server stdout ended before transport closure",
    );
    await expect(transport.request("after-stdout-end", {})).rejects.toThrow(
      "codex app-server transport is closed",
    );
    await transport.close();
  });

  it("fails closed when stdout is destroyed without a usable response channel", async () => {
    const transport = nodeTransport(
      'process.stdin.resume(); require("node:fs").closeSync(1); setInterval(() => {}, 1000)',
    );
    await expect(transport.request("pending", {})).rejects.toThrow(/stdout (ended|closed)/u);
    await expect(transport.request("after-stdout-close", {})).rejects.toThrow(
      "codex app-server transport is closed",
    );
    await transport.close();
  });

  it("fails closed when outbound buffering exceeds its bound", async () => {
    const diagnostics: string[] = [];
    const transport = nodeTransport("process.stdin.pause(); setInterval(() => {}, 1000)", {
      maxLineBytes: 1_024,
      maxBufferedOutputBytes: 64,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(() => transport.notify("large", { value: "x".repeat(100) })).toThrow(
      "outbound codex JSON-RPC buffer exceeded 64 bytes",
    );
    expect(diagnostics).toContain(
      "outbound codex JSON-RPC buffer exceeded 64 bytes",
    );
    await expect(transport.request("after-close", {})).rejects.toThrow(
      "codex app-server transport is closed",
    );
    await transport.close();
  });

  it("routes an oversized server response through deterministic closure", async () => {
    let transport: ProcessCodexAppServerTransport | undefined;
    const diagnostic = new Promise<string>((resolve) => {
      transport = nodeTransport(
        `setTimeout(() => process.stdout.write(JSON.stringify({ id: "server-1", method: "tool/call", params: {} }) + "\\n"), 20); setInterval(() => {}, 1000)`,
        {
          maxLineBytes: 128,
          onDiagnostic: (message) => resolve(message),
        },
      );
      transport.setServerRequestHandler(async () => ({ value: "x".repeat(256) }));
    });

    await expect(diagnostic).resolves.toBe(
      "outbound codex JSON-RPC line exceeded 128 bytes",
    );
    await transport?.close();
  });

  it("turns a synchronous server handler throw into a JSON-RPC error", async () => {
    const transport = nodeTransport(`
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", (chunk) => {
        const response = JSON.parse(chunk.trim());
        process.stdout.write(JSON.stringify({ method: "observed", params: response }) + "\\n");
      });
      setTimeout(() => process.stdout.write(JSON.stringify({ id: "server-1", method: "tool/call", params: {} }) + "\\n"), 20);
      setInterval(() => {}, 1000);
    `);
    transport.setServerRequestHandler((): Promise<Record<string, unknown>> => {
      throw new Error("synchronous handler failure");
    });

    await expect(
      transport.notifications()[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({
      done: false,
      value: {
        method: "observed",
        params: {
          id: "server-1",
          error: { code: -32_000, message: "Error: synchronous handler failure" },
        },
      },
    });
    await transport.close();
  });

  it("routes an asynchronous child-stdin failure through deterministic closure", async () => {
    const diagnostics: string[] = [];
    const transport = nodeTransport(
      `require("node:fs").closeSync(0); process.stdout.write(JSON.stringify({ method: "ready", params: {} }) + "\\n"); setInterval(() => {}, 1000)`,
      { onDiagnostic: (message) => diagnostics.push(message) },
    );
    const notifications = transport.notifications()[Symbol.asyncIterator]();
    await expect(notifications.next()).resolves.toMatchObject({
      done: false,
      value: { method: "ready" },
    });

    await expect(transport.request("after-stdin-close", {})).rejects.toThrow();
    expect(diagnostics.some((message) => /EPIPE|closed|write/u.test(message))).toBe(true);
    await transport.close();
  });
});
