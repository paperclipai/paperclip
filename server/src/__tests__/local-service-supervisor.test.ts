import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive, readLocalServicePortOwner, terminateLocalService } from "../services/local-service-supervisor.js";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

async function spawnPortHolder(port: number): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("net"); const s = net.createServer(); s.listen(${port}, "127.0.0.1", () => { process.stdout.write("ready\\n"); }); process.on("SIGTERM", () => { s.close(() => process.exit(0)); });`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("port holder startup timeout")), 5_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`port holder exited with code ${code}`));
    });
  });
  return child;
}

describe.skipIf(process.platform === "win32")("terminateLocalService port cleanup", () => {
  const children: ReturnType<typeof spawn>[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  });

  it("frees the port when the watcher PID is already dead but the port is still occupied", async () => {
    const port = await findFreePort();
    const holder = await spawnPortHolder(port);
    children.push(holder);

    // Holder has signalled ready — lsof should see it immediately.
    const ownerBefore = await readLocalServicePortOwner(port);
    expect(ownerBefore).toBe(holder.pid);

    // Simulate the case where the dev-runner watcher is already gone but the API server survives.
    const deadPid = 999_999;
    await terminateLocalService(
      { pid: deadPid, processGroupId: null },
      { cleanupPort: port, forceAfterMs: 5_000 },
    );

    const ownerAfter = await readLocalServicePortOwner(port);
    expect(ownerAfter).toBeNull();
  }, 10_000);

  it("frees the port when the watcher is killed but a descendant keeps the port bound", async () => {
    const port = await findFreePort();

    // "Watcher": killed by terminateLocalService (simulates the dev-runner watcher).
    const watcher = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)"], { stdio: "ignore" });
    children.push(watcher);

    // "API server": a sibling child holding the port (simulates the orphaned grandchild server).
    const holder = await spawnPortHolder(port);
    children.push(holder);

    const ownerBefore = await readLocalServicePortOwner(port);
    expect(ownerBefore).toBe(holder.pid);
    expect(isPidAlive(watcher.pid!)).toBe(true);

    await terminateLocalService(
      { pid: watcher.pid!, processGroupId: null },
      { cleanupPort: port, forceAfterMs: 5_000 },
    );

    expect(isPidAlive(watcher.pid!)).toBe(false);
    const ownerAfter = await readLocalServicePortOwner(port);
    expect(ownerAfter).toBeNull();
  }, 10_000);
});
