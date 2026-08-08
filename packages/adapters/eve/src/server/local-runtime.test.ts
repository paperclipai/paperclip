import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pickFreePort, spawnEveServer, stopEveServer, waitForReady } from "./local-runtime.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fake-eve-server.mjs",
);

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

describe("pickFreePort", () => {
  it("returns a bindable port", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
    });
  });
});

describe("spawnEveServer", () => {
  it("boots the fixture server, becomes ready, and stops cleanly", async () => {
    const port = await pickFreePort();
    const logs: string[] = [];
    const handle = await spawnEveServer({
      projectDir: process.cwd(),
      command: process.execPath,
      args: [fixturePath],
      port,
      env: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    expect(handle.pid).toBeGreaterThan(0);
    await waitForReady({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: {},
      timeoutMs: 15_000,
      pollIntervalMs: 100,
    });
    await stopEveServer(handle, { graceMs: 5_000 });
    expect(handle.hasExited()).toBe(true);
    const gone = await waitFor(() => processGone(handle.pid), 5_000);
    expect(gone).toBe(true);
    expect(logs.join("")).toContain("[eve] ");
  }, 30_000);

  it("rejects with an install hint when the command does not exist", async () => {
    await expect(
      spawnEveServer({
        projectDir: process.cwd(),
        command: "definitely-not-a-real-eve-binary-xyz",
        args: ["dev", "--no-ui"],
        port: 1234,
        env: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow(/npm i -g eve|"command" config field/);
  });
});

describe("waitForReady", () => {
  it("times out against a dead port with a clear error", async () => {
    const port = await pickFreePort();
    await expect(
      waitForReady({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: {},
        timeoutMs: 1_500,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow(/did not become ready within 1500ms/);
  }, 10_000);
});
