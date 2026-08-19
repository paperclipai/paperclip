import { describe, expect, it } from "vitest";

import { ProcessCodexAppServerTransport } from "./app-server-transport.js";

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
  it("reports restart-safe process-group ownership", async () => {
    const transport = nodeTransport("process.stdin.resume()", { processGroup: true });
    const info = transport.processInfo();

    expect(info.pid).toBeGreaterThan(0);
    expect(info.processGroupId).toBe(process.platform === "win32" ? null : info.pid);
    expect(new Date(info.startedAt).toISOString()).toBe(info.startedAt);

    await transport.close();
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
});
