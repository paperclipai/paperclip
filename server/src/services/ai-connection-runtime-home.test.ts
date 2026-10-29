import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimManagedAiHome, MANAGED_AI_STABLE_HOME_STALE_AFTER_MS } from "./ai-connection-runtime.js";

const writeFileFailureCountdown = vi.hoisted(() => ({ remaining: 0 }));
const fakeProcStartTimes = vi.hoisted(() => new Map<number, number>());
const realProcPids = vi.hoisted(() => new Set<number>());
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    writeFile: async (...args: Parameters<typeof filesystem.writeFile>) => {
      if (writeFileFailureCountdown.remaining > 0) {
        writeFileFailureCountdown.remaining -= 1;
        throw new Error("simulated disk failure");
      }
      return filesystem.writeFile(...args);
    },
    lstat: async (...args: Parameters<typeof filesystem.lstat>) => {
      const target = args[0];
      const match = typeof target === "string" ? /^\/proc\/(\d+)$/.exec(target) : null;
      if (match) {
        const pid = Number(match[1]);
        if (realProcPids.has(pid)) return filesystem.lstat(...args);
        if (!fakeProcStartTimes.has(pid)) throw Object.assign(new Error("no such process"), { code: "ENOENT" });
        return { ctimeMs: fakeProcStartTimes.get(pid)! } as Awaited<ReturnType<typeof filesystem.lstat>>;
      }
      return filesystem.lstat(...args);
    },
  };
});

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", "0"]).pid!;
}

const roots: string[] = [];
async function tmpRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-home-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  writeFileFailureCountdown.remaining = 0;
  fakeProcStartTimes.clear();
  realProcPids.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("claimManagedAiHome", () => {
  it("claims the stable path when nothing holds it yet", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const result = await claimManagedAiHome(baseDir);
    expect(result).toEqual({ home: baseDir, stable: true });
    expect((await stat(baseDir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path.join(baseDir, ".paperclip-home-claim.json"), "utf8"))).toMatchObject({ pid: process.pid });
  });

  it("reclaims the same stable path on the next run after cleanup removes it", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const first = await claimManagedAiHome(baseDir);
    await rm(first.home, { recursive: true, force: true });
    const second = await claimManagedAiHome(baseDir);
    expect(second).toEqual({ home: baseDir, stable: true });
  });

  it("falls back to a fresh unique directory without disturbing a live claim", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const live = await claimManagedAiHome(baseDir);
    await writeFile(path.join(live.home, "sentinel.txt"), "in-flight-run");

    const concurrent = await claimManagedAiHome(baseDir);

    expect(concurrent.stable).toBe(false);
    expect(concurrent.home).not.toBe(baseDir);
    expect(concurrent.home.startsWith(`${baseDir}-`)).toBe(true);
    expect(await readFile(path.join(live.home, "sentinel.txt"), "utf8")).toBe("in-flight-run");
  });

  it("never lets two concurrent callers both win the stable path", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const [a, b] = await Promise.all([claimManagedAiHome(baseDir), claimManagedAiHome(baseDir)]);
    const stableWinners = [a, b].filter((result) => result.stable);
    expect(stableWinners).toHaveLength(1);
    expect(stableWinners[0]!.home).toBe(baseDir);
    expect(a.home).not.toBe(b.home);
  });

  it("treats a claim with no readable marker as live, not stale", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });

    const result = await claimManagedAiHome(baseDir);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
  });

  it("reclaims a claim left behind by a run that crashed before cleanup", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, "leftover-credential.txt"), "stale");
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: deadPid(), claimedAt: 1_000_000 }));

    const result = await claimManagedAiHome(baseDir, () => 1_000_000 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS + 1);

    expect(result).toEqual({ home: baseDir, stable: true });
    await expect(stat(path.join(baseDir, "leftover-credential.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reclaim a claim that is merely old-ish, below the staleness threshold", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    let now = 1_000_000;
    await claimManagedAiHome(baseDir, () => now);

    now += MANAGED_AI_STABLE_HOME_STALE_AFTER_MS - 1;
    const result = await claimManagedAiHome(baseDir, () => now);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
  });

  it("never reclaims a claim whose owning process is still alive, no matter how old the timestamp is", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, "live-credential.txt"), "in-flight-run");
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: process.pid, claimedAt: 1_000_000 }));

    const result = await claimManagedAiHome(baseDir, () => 1_000_000 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
    expect(await readFile(path.join(baseDir, "live-credential.txt"), "utf8")).toBe("in-flight-run");
  });

  it("refuses to trust or delete a pre-existing world-writable directory at the stable path", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o777 });
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: deadPid(), claimedAt: 1 }));

    const result = await claimManagedAiHome(baseDir, () => 1 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
    await expect(stat(baseDir)).resolves.toBeDefined();
  });

  it("never lets a second reclaiming caller destroy the home the first caller just recreated", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: deadPid(), claimedAt: 1 }));
    const now = () => 1 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10;

    const [a, b] = await Promise.all([claimManagedAiHome(baseDir, now), claimManagedAiHome(baseDir, now)]);

    const stableWinners = [a, b].filter((result) => result.stable);
    expect(stableWinners).toHaveLength(1);
    expect(stableWinners[0]!.home).toBe(baseDir);
    await expect(stat(baseDir)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(path.join(baseDir, ".paperclip-home-claim.json"), "utf8"))).toMatchObject({ pid: process.pid });
  });

  it("cleans up the claimed directory if writing the marker fails, instead of leaking it forever", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    writeFileFailureCountdown.remaining = 1;

    const failed = await claimManagedAiHome(baseDir);

    expect(failed.stable).toBe(false);
    await expect(stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });

    const retried = await claimManagedAiHome(baseDir);
    expect(retried).toEqual({ home: baseDir, stable: true });
  });

  it("never reclaims a claim marked retry-pending after a failed credential write-back, even once its owner is gone", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, "unsaved-rotated-token.txt"), "single-use");
    await writeFile(
      path.join(baseDir, ".paperclip-home-claim.json"),
      JSON.stringify({ pid: deadPid(), claimedAt: 1_000_000, retryPending: true }),
    );

    const result = await claimManagedAiHome(baseDir, () => 1_000_000 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
    expect(await readFile(path.join(baseDir, "unsaved-rotated-token.txt"), "utf8")).toBe("single-use");
  });

  it("reclaims a stale claim whose pid was reused by an unrelated, newer process", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    fakeProcStartTimes.set(process.pid, 5_000);
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, "leftover-credential.txt"), "stale");
    await writeFile(
      path.join(baseDir, ".paperclip-home-claim.json"),
      JSON.stringify({ pid: process.pid, claimedAt: 1_000_000, startedAtMs: 1_000 }),
    );

    const result = await claimManagedAiHome(baseDir, () => 1_000_000 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS + 1);

    expect(result).toEqual({ home: baseDir, stable: true });
    await expect(stat(path.join(baseDir, "leftover-credential.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reclaim a stale claim whose live pid's start time still matches the claim", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    fakeProcStartTimes.set(process.pid, 5_000);
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, "live-credential.txt"), "in-flight-run");
    await writeFile(
      path.join(baseDir, ".paperclip-home-claim.json"),
      JSON.stringify({ pid: process.pid, claimedAt: 1_000_000, startedAtMs: 5_000 }),
    );

    const result = await claimManagedAiHome(baseDir, () => 1_000_000 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
    expect(await readFile(path.join(baseDir, "live-credential.txt"), "utf8")).toBe("in-flight-run");
  });

  it.runIf(process.platform === "linux")(
    "reads a real live process's actual /proc start time, not a faked one, to decide it still owns the claim",
    async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"]);
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      realProcPids.add(child.pid!);
      const root = await tmpRoot();
      const baseDir = path.join(root, "paperclip-ai-co-grant");
      try {
        const realStartedAtMs = (await lstat(`/proc/${child.pid}`)).ctimeMs;
        await mkdir(baseDir, { mode: 0o700 });
        await writeFile(path.join(baseDir, "live-credential.txt"), "in-flight-run");
        await writeFile(
          path.join(baseDir, ".paperclip-home-claim.json"),
          JSON.stringify({ pid: child.pid, claimedAt: 1, startedAtMs: realStartedAtMs }),
        );

        const whileAlive = await claimManagedAiHome(baseDir, () => 1 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);

        expect(whileAlive.stable).toBe(false);
        expect(whileAlive.home).not.toBe(baseDir);
        expect(await readFile(path.join(baseDir, "live-credential.txt"), "utf8")).toBe("in-flight-run");
      } finally {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }

      const afterExit = await claimManagedAiHome(baseDir, () => 1 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);
      expect(afterExit).toEqual({ home: baseDir, stable: true });
    },
  );
});
