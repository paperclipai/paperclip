import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendServerLifecycleEvent,
  beginServerLifecycle,
  claimEmbeddedPostgresOwnershipRecovery,
  claimEmbeddedPostgresStartupRecovery,
  writeEmbeddedPostgresOwnership,
  findMissingHotRestartSnapshotRunIds,
  isObservedHotRestartTargetAlive,
  readHotRestartIntent,
  readServerLifecycleJournal,
  readProcessStartedAt,
  releaseEmbeddedPostgresStartupRecovery,
  removeHotRestartIntent,
  resolveHotRestartIntentPath,
  resolveLegacyHotRestartIntentPath,
  resolveEmbeddedPostgresHandoffPath,
  writeHotRestartIntent,
  writeEmbeddedPostgresHandoff,
  writeEmbeddedPostgresStartupRecovery,
} from "./hot-restart.js";

const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
});

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-paths-"));
  try {
    return await fn(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

describe("hot-restart path compatibility", { timeout: 30_000 }, () => {
  it("reads Linux process start time from proc metadata", async () => {
    await expect(
      readProcessStartedAt(123, {
        platform: "linux",
        stat: async (target) => {
          expect(target).toBe("/proc/123");
          return {
            ctimeMs: Date.parse("2026-08-01T01:00:00.123Z"),
          };
        },
      }),
    ).resolves.toBe("2026-08-01T01:00:00.123Z");
  });

  it("reads macOS process start time through ps", async () => {
    await expect(
      readProcessStartedAt(456, {
        platform: "darwin",
        runCommand: async (command, args) => {
          expect([command, ...args]).toEqual([
            "ps",
            "-o",
            "lstart=",
            "-p",
            "456",
          ]);
          return "Fri Aug  1 01:02:03 2026\n";
        },
      }),
    ).resolves.toBe(new Date("Fri Aug  1 01:02:03 2026").toISOString());
  });

  it("reads Windows process start time through PowerShell", async () => {
    await expect(
      readProcessStartedAt(789, {
        platform: "win32",
        runCommand: async (command, args) => {
          expect(command).toBe("powershell.exe");
          expect(args.at(-1)).toContain("Get-Process -Id 789");
          return "2026-08-01T01:02:03.456Z\r\n";
        },
      }),
    ).resolves.toBe("2026-08-01T01:02:03.456Z");
  });

  it("falls back from Windows PowerShell to pwsh", async () => {
    const commands: string[] = [];
    await expect(
      readProcessStartedAt(790, {
        platform: "win32",
        runCommand: async (command) => {
          commands.push(command);
          if (command === "powershell.exe") throw new Error("not installed");
          return "2026-08-01T01:02:04.000Z\n";
        },
      }),
    ).resolves.toBe("2026-08-01T01:02:04.000Z");
    expect(commands).toEqual(["powershell.exe", "pwsh.exe"]);
  });

  it("surfaces supported-platform process identity probe failures", async () => {
    await expect(readProcessStartedAt(791, {
      platform: "darwin",
      runCommand: async () => {
        throw new Error("ps unavailable");
      },
    })).rejects.toThrow("ps unavailable");
  });

  it("distinguishes recycled PIDs and rejects unknown live claim classification", () => {
    const intent = {
      version: 1 as const,
      requestedAt: "2026-08-01T01:05:00.000Z",
      previousServerPid: 123,
      previousServerIdentity: "server-boot-a",
      previousServerStartedAt: "2026-08-01T01:00:00.000Z",
      previousServerVersion: "old-version",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: [],
    };

    expect(isObservedHotRestartTargetAlive(intent, {
      alive: true,
      startedAt: "2026-08-01T01:00:00.000Z",
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "server-boot-a",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(intent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "server-boot-b",
      },
    })).toBe(false);

    const legacyIntent = {
      ...intent,
      previousServerIdentity: null,
      previousServerStartedAt: null,
    };
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: "2026-08-01T01:06:00.000Z",
    })).toBe(false);
    expect(() => isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
    })).toThrow("Cannot establish process identity");
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "2026-08-01T01:04:00.000Z",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "2026-08-01T01:06:00.000Z",
      },
    })).toBe(false);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: null,
        previousServerStartedAt: "2026-08-01T01:04:00.000Z",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: null,
        previousServerStartedAt: "2026-08-01T01:06:00.000Z",
      },
    })).toBe(false);
  });

  it("refuses to create an unidentifiable process claim", async () => {
    await withTempHome(async (homeDir) => {
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: null,
      })).rejects.toThrow("process start time are unavailable");

      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(resolveLegacyHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reclaims a live recycled PID when server boot identities differ", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        previousServerIdentity: "server-boot-a",
        requestedByRunId: "blue-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        previousServerIdentity: "server-boot-b",
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({
        previousServerIdentity: "server-boot-b",
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("writes both paths but does not merge a legacy snapshot from another request", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "blue";

    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 101,
        previousServerStartedAt: "2026-08-01T01:00:00.000Z",
        requestedAt: new Date("2026-08-01T02:00:00.000Z"),
        requestedByRunId: "blue-deploy",
        preflightActiveRunIds: ["blue-run"],
      });
      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).resolves.toBeDefined();
      await expect(fs.stat(resolveLegacyHotRestartIntentPath(homeDir))).resolves.toBeDefined();

      const unrelatedLegacyIntent = {
        version: 1,
        requestedAt: "2026-08-01T02:00:01.000Z",
        previousServerPid: 202,
        previousServerVersion: "other-instance",
        drainRequired: false,
        requestedByRunId: "other-deploy",
        shutdownSnapshot: {
          capturedAt: "2026-08-01T02:00:02.000Z",
          signal: "SIGTERM",
          activeRuns: [],
        },
      };
      await fs.writeFile(
        resolveLegacyHotRestartIntentPath(homeDir),
        `${JSON.stringify(unrelatedLegacyIntent, null, 2)}\n`,
        "utf8",
      );

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: 101,
        requestedByRunId: "blue-deploy",
        preflightActiveRunIds: ["blue-run"],
      });
      expect((await readHotRestartIntent(homeDir))?.shutdownSnapshot).toBeUndefined();
    });
  });

  it("does not let a non-default instance consume an uncorrelated legacy-only marker", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "green";

    await withTempHome(async (homeDir) => {
      await fs.writeFile(
        resolveLegacyHotRestartIntentPath(homeDir),
        `${JSON.stringify({
          version: 1,
          requestedAt: "2026-08-01T03:00:00.000Z",
          previousServerPid: 303,
          previousServerVersion: "legacy",
          drainRequired: false,
          requestedByRunId: null,
        })}\n`,
        "utf8",
      );

      await expect(readHotRestartIntent(homeDir)).resolves.toBeNull();
    });
  });

  it("ignores a malformed legacy marker when the instance marker is valid", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "blue";

    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 304,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:30:00.000Z"),
        preflightActiveRunIds: ["blue-run"],
      });
      await fs.writeFile(resolveLegacyHotRestartIntentPath(homeDir), "not-json", "utf8");

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: 304,
        preflightActiveRunIds: ["blue-run"],
      });
    });
  });

  it("does not overwrite another instance's active legacy handoff", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2026-08-01T03:40:00.000Z"),
        requestedByRunId: "blue-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: 502,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:40:01.000Z"),
        requestedByRunId: "green-deploy",
      })).rejects.toMatchObject({ code: "EEXIST" });

      const legacyIntent = JSON.parse(
        await fs.readFile(resolveLegacyHotRestartIntentPath(homeDir), "utf8"),
      ) as Record<string, unknown>;
      expect(legacyIntent).toMatchObject({
        previousServerPid: process.pid,
        requestedByRunId: "blue-deploy",
      });
      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reclaims an abandoned legacy handoff after its target process exits", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:50:00.000Z"),
        requestedByRunId: "abandoned-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2026-08-01T03:51:00.000Z"),
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({ requestedByRunId: "green-deploy" });

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: process.pid,
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("reclaims an abandoned handoff when its PID belongs to a newer process", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2020-01-01T00:00:00.000Z"),
        requestedByRunId: "expired-deploy",
      });
      const legacyPath = resolveLegacyHotRestartIntentPath(homeDir);
      const legacyIntent = JSON.parse(
        await fs.readFile(legacyPath, "utf8"),
      ) as Record<string, unknown>;
      delete legacyIntent.previousServerStartedAt;
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify(legacyIntent, null, 2)}\n`,
        "utf8",
      );

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({ requestedByRunId: "green-deploy" });

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("keeps an old handoff while its original target process is alive", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date(),
        requestedByRunId: "blue-deploy",
      });

      vi.useFakeTimers({ now: Date.now() + 10 * 60_000 });
      try {
        process.env.PAPERCLIP_INSTANCE_ID = "green";
        await expect(writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          requestedByRunId: "green-deploy",
        })).rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not let matching cleanup delete replacement intent markers", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      const abandonedIntent = await writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:55:00.000Z"),
        requestedByRunId: "abandoned-deploy",
      });

      await Promise.all([
        removeHotRestartIntent(homeDir, abandonedIntent),
        writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          requestedAt: new Date("2026-08-01T03:56:00.000Z"),
          requestedByRunId: "replacement-deploy",
        }),
      ]);

      const legacyIntent = JSON.parse(
        await fs.readFile(resolveLegacyHotRestartIntentPath(homeDir), "utf8"),
      ) as Record<string, unknown>;
      expect(legacyIntent).toMatchObject({ requestedByRunId: "replacement-deploy" });
      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        requestedByRunId: "replacement-deploy",
      });
    });
  });

  it("treats every preflight run omitted from the shutdown snapshot as missing", () => {
    expect(findMissingHotRestartSnapshotRunIds({
      version: 1,
      requestedAt: "2026-08-01T04:00:00.000Z",
      previousServerPid: 404,
      previousServerVersion: "old-version",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: ["captured-run", "missing-run"],
      shutdownSnapshot: {
        capturedAt: "2026-08-01T04:00:01.000Z",
        signal: "SIGTERM",
        activeRuns: [{
          runId: "captured-run",
          companyId: "company",
          agentId: "agent",
          adapterType: "codex_local",
          status: "running",
          processPid: 405,
          processGroupId: null,
          issueId: "issue",
        }],
      },
    })).toEqual(["missing-run"]);
  });

  it("persists only allowlisted lifecycle provenance and closes intentional boots", async () => {
    await withTempHome(async (homeDir) => {
      const boot = await beginServerLifecycle({
        homeDir,
        serverPid: 7001,
        serverStartedAtEpochMs: 1_754_000_000_000,
        launcherIdentity: "node:paperclipai",
        startedAt: new Date("2026-08-02T01:00:00.000Z"),
        isProcessAlive: () => false,
      });
      await appendServerLifecycleEvent({
        homeDir,
        bootId: boot.bootId,
        type: "hot_restart",
        signal: "SIGBREAK",
        exitCode: 0,
        postgresPid: 7002,
        cleanupOutcome: "not_applicable",
        completeBoot: true,
      });

      const journal = await readServerLifecycleJournal(homeDir);
      expect(journal.activeBoot).toBeNull();
      expect(journal.completedBoots).toEqual([
        expect.objectContaining({
          bootId: boot.bootId,
          serverPid: 7001,
          launcherIdentity: "node:paperclipai",
          events: [{
            type: "hot_restart",
            at: expect.any(String),
            signal: "SIGBREAK",
            exitCode: 0,
            postgresPid: 7002,
            cleanupOutcome: "not_applicable",
          }],
        }),
      ]);
      expect(JSON.stringify(journal)).not.toContain("DATABASE_URL");
      expect(JSON.stringify(journal)).not.toContain("transferToken");
    });
  });

  it("reconciles an unclosed prior boot as an unexpected exit on the next boot", async () => {
    await withTempHome(async (homeDir) => {
      const prior = await beginServerLifecycle({
        homeDir,
        serverPid: 7101,
        serverStartedAtEpochMs: 1_754_000_000_000,
        launcherIdentity: "node:paperclipai",
        isProcessAlive: () => false,
      });
      const replacement = await beginServerLifecycle({
        homeDir,
        serverPid: 7102,
        serverStartedAtEpochMs: 1_754_000_100_000,
        launcherIdentity: "node:paperclipai",
        isProcessAlive: () => false,
      });

      const journal = await readServerLifecycleJournal(homeDir);
      expect(journal.activeBoot?.bootId).toBe(replacement.bootId);
      expect(journal.completedBoots).toEqual([
        expect.objectContaining({
          bootId: prior.bootId,
          events: [expect.objectContaining({ type: "unexpected_exit", exitCode: null })],
        }),
      ]);
    });
  });

  it("keeps failed-startup PostgreSQL recovery authority durable across replacement exits", async () => {
    await withTempHome(async (homeDir) => {
      const postgres = {
        pid: 7201,
        startedAtEpochSeconds: 1_754_000_000,
        processStartedAtEpochMs: 1_754_000_000_250,
        executablePath: path.resolve(homeDir, "postgres.exe"),
        dataDir: path.resolve(homeDir, "postgres"),
        port: 5432,
      };
      await writeEmbeddedPostgresStartupRecovery({
        homeDir,
        predecessorServerPid: 7200,
        predecessorServerStartedAtEpochMs: 1_754_000_000_000,
        postgres,
        now: new Date("2026-08-02T01:10:00.000Z"),
      });

      await expect(claimEmbeddedPostgresStartupRecovery({
        homeDir,
        expectedPostgres: postgres,
        isProcessAlive: () => true,
      })).resolves.toBeNull();
      await expect(claimEmbeddedPostgresStartupRecovery({
        homeDir,
        expectedPostgres: { ...postgres, startedAtEpochSeconds: postgres.startedAtEpochSeconds + 1 },
        isProcessAlive: () => false,
      })).resolves.toBeNull();
      await expect(claimEmbeddedPostgresStartupRecovery({
        homeDir,
        expectedPostgres: postgres,
        replacementServerPid: 7202,
        replacementServerStartedAtEpochMs: 1_754_000_200_000,
        isProcessAlive: () => false,
      })).resolves.toEqual(expect.objectContaining({
        predecessorServerPid: 7202,
        predecessorServerStartedAtEpochMs: 1_754_000_200_000,
        postgres,
      }));
      await expect(claimEmbeddedPostgresStartupRecovery({
        homeDir,
        expectedPostgres: postgres,
        isProcessAlive: () => true,
      })).resolves.toBeNull();
      await expect(claimEmbeddedPostgresStartupRecovery({
        homeDir,
        expectedPostgres: postgres,
        replacementServerPid: 7203,
        replacementServerStartedAtEpochMs: 1_754_000_300_000,
        isProcessAlive: () => false,
      })).resolves.toEqual(expect.objectContaining({
        predecessorServerPid: 7203,
        predecessorServerStartedAtEpochMs: 1_754_000_300_000,
        postgres,
      }));
      await expect(releaseEmbeddedPostgresStartupRecovery({
        homeDir,
        ownerServerPid: 7203,
        ownerServerStartedAtEpochMs: 1_754_000_300_000,
        expectedPostgres: postgres,
      })).resolves.toBe(true);
      await expect(claimEmbeddedPostgresStartupRecovery({
        homeDir,
        expectedPostgres: postgres,
        isProcessAlive: () => false,
      })).resolves.toBeNull();
    });
  });
});

// FAI-9637 F2: ownership is persisted durably BEFORE a replacement adopts the
// embedded PostgreSQL process, so a crash after adopt() does not strand ownership
// in memory. A durable receipt naming a now-dead replacement stays recoverable by
// the next server. This encodes the refutation of "ownership only in memory".
describe("embedded PostgreSQL ownership survives a post-adopt replacement crash", () => {
  const postgres = {
    pid: 7777,
    startedAtEpochSeconds: 1_700_000_000,
    processStartedAtEpochMs: 1_700_000_000_000,
    executablePath: "/usr/lib/postgresql/16/bin/postgres",
    dataDir: "/var/lib/paperclip/pgdata",
    port: 5434,
  };

  it("recovers ownership from the durable receipt after the recorded owner dies", async () => {
    await withTempHome(async (homeDir) => {
      // The durable receipt a replacement writes during its ownership claim,
      // before it calls adopt(). Then it crashes (recorded owner pid is dead).
      await writeEmbeddedPostgresOwnership({
        homeDir,
        ownerServerPid: 424242,
        ownerServerStartedAtEpochMs: 1_699_999_000_000,
        ownerServerExecutablePath: "/rt/node",
        postgres,
      });

      const recovered = await claimEmbeddedPostgresOwnershipRecovery({
        homeDir,
        expectedPostgres: postgres,
        replacementServerPid: 999001,
        replacementServerStartedAtEpochMs: 1_700_000_500_000,
        replacementServerExecutablePath: "/rt/node",
        isProcessAlive: () => false,
      });

      expect(recovered).not.toBeNull();
      expect(recovered?.replacementServerPid).toBe(999001);
      expect(recovered?.postgres.pid).toBe(postgres.pid);
    });
  });
});

// FAI-9637 F4: the hot-restart handoff carries a one-time transferToken. Its
// file (and the private state directory) must not be world-readable under a
// typical umask. POSIX mode bits are meaningless on win32, so this only asserts
// on non-Windows CI (matches the platform gate in ensurePrivateStateDirectory).
describe.skipIf(process.platform === "win32")("hot-restart handoff file permissions", () => {
  const postgres = {
    pid: 4321,
    startedAtEpochSeconds: 1_700_000_000,
    processStartedAtEpochMs: 1_700_000_000_000,
    executablePath: "/usr/lib/postgresql/16/bin/postgres",
    dataDir: "/var/lib/paperclip/pgdata",
    port: 5433,
  };

  it("writes the transfer-token handoff 0600 inside a 0700 state directory", async () => {
    await withTempHome(async (homeDir) => {
      const handoff = await writeEmbeddedPostgresHandoff({
        homeDir,
        hotRestartRequestedAt: new Date().toISOString(),
        shutdownSnapshotCapturedAt: new Date().toISOString(),
        predecessorServerPid: 1234,
        predecessorServerStartedAtEpochMs: 1_699_999_000_000,
        predecessorServerExecutablePath: "/rt/node",
        postgres,
      });
      expect(handoff.transferToken).toBeTruthy();

      const handoffPath = resolveEmbeddedPostgresHandoffPath(homeDir);
      const fileStat = await fs.stat(handoffPath);
      expect(fileStat.mode & 0o777).toBe(0o600);

      const dirStat = await fs.stat(path.dirname(handoffPath));
      expect(dirStat.mode & 0o777).toBe(0o700);
    });
  });
});
