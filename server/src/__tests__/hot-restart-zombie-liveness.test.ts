import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOT_RESTART_LOCK_SUFFIX,
  readProcessStartedAt,
  resolveLegacyHotRestartIntentPath,
  writeHotRestartIntent,
} from "../services/hot-restart.js";
import {
  disposeZombieLeadProcessGroup,
  readLinuxProcessState,
  spawnZombieLeadProcessGroup,
} from "./helpers/zombie-process.js";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-zombie-"));
  try {
    return await fn(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

// The zombie shape is built from /proc, so this whole file only runs on Linux.
const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("hot-restart liveness against an unreaped previous server pid", () => {
  it("reclaims a path lock whose owner pid is an unreaped zombie", async () => {
    const zombie = await spawnZombieLeadProcessGroup();
    try {
      expect(readLinuxProcessState(zombie.zombiePid)).toBe("Z");
      await withTempHome(async (homeDir) => {
        const legacyPath = resolveLegacyHotRestartIntentPath(homeDir);
        const lockDir = `${legacyPath}${HOT_RESTART_LOCK_SUFFIX}`;
        await fs.mkdir(lockDir, { recursive: true });
        // Written now, so the lock is far inside its staleness window and only
        // the owner-liveness check can clear it.
        await fs.writeFile(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: zombie.zombiePid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );

        await expect(writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          previousServerStartedAt: "2026-08-01T05:00:00.000Z",
          requestedAt: new Date("2026-08-01T05:30:00.000Z"),
        })).resolves.toMatchObject({ previousServerPid: process.pid });

        // The sweep removed the abandoned lock and the acquire/release cycle
        // left nothing behind.
        await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      disposeZombieLeadProcessGroup(zombie);
    }
  });

  it("reclaims an abandoned legacy marker whose previous server pid is an unreaped zombie", async () => {
    const zombie = await spawnZombieLeadProcessGroup();
    try {
      expect(readLinuxProcessState(zombie.zombiePid)).toBe("Z");
      await withTempHome(async (homeDir) => {
        const legacyPath = resolveLegacyHotRestartIntentPath(homeDir);
        await fs.mkdir(path.dirname(legacyPath), { recursive: true });
        // A zombie keeps a readable /proc entry, so its recorded start time
        // still matches what the marker captured. Start-time comparison cannot
        // tell the two apart — only the process state can.
        const abandonedStartedAt = await readProcessStartedAt(zombie.zombiePid);
        expect(abandonedStartedAt).toBeTypeOf("string");
        await fs.writeFile(
          legacyPath,
          `${JSON.stringify({
            version: 1,
            requestedAt: "2026-08-01T05:00:00.000Z",
            previousServerPid: zombie.zombiePid,
            previousServerStartedAt: abandonedStartedAt,
            previousServerVersion: "abandoned",
            drainRequired: false,
            requestedByRunId: "abandoned-deploy",
          })}\n`,
          "utf8",
        );

        await expect(writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          previousServerStartedAt: "2026-08-01T05:00:00.000Z",
          requestedAt: new Date("2026-08-01T05:30:00.000Z"),
          requestedByRunId: "fresh-deploy",
        })).resolves.toMatchObject({ previousServerPid: process.pid });

        const legacyIntent = JSON.parse(
          await fs.readFile(legacyPath, "utf8"),
        ) as Record<string, unknown>;
        expect(legacyIntent).toMatchObject({
          previousServerPid: process.pid,
          requestedByRunId: "fresh-deploy",
        });
      });
    } finally {
      disposeZombieLeadProcessGroup(zombie);
    }
  });
});
