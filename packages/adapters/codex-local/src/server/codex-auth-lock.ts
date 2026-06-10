import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const LOCK_ROOT = path.join(os.tmpdir(), "paperclip-codex-auth-locks");
const LOCK_POLL_MS = 100;
const LOCK_HEARTBEAT_MS = 30_000;
const STALE_LOCK_MS = 30 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdapterApiKeyAuth(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    typeof value.OPENAI_API_KEY === "string" &&
    value.OPENAI_API_KEY.trim().length > 0
  );
}

async function authFileNeedsRefreshLock(authPath: string): Promise<boolean> {
  const contents = await fs.readFile(authPath, "utf8").catch(() => null);
  if (contents == null) return true;

  try {
    return !isAdapterApiKeyAuth(JSON.parse(contents));
  } catch {
    return true;
  }
}

async function resolveCodexAuthLock(codexHome: string): Promise<{
  realAuthPath: string;
  lockDir: string;
} | null> {
  const authPath = path.join(codexHome, "auth.json");
  const realAuthPath = await fs.realpath(authPath).catch(() => null);
  if (!realAuthPath) return null;
  if (!(await authFileNeedsRefreshLock(realAuthPath))) return null;

  const digest = crypto.createHash("sha256").update(realAuthPath).digest("hex");
  return {
    realAuthPath,
    lockDir: path.join(LOCK_ROOT, `${digest}.lock`),
  };
}

async function removeStaleLock(
  lockDir: string,
  realAuthPath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<boolean> {
  const stat = await fs.stat(lockDir).catch(() => null);
  if (!stat || Date.now() - stat.mtimeMs < STALE_LOCK_MS) return false;

  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  await onLog(
    "stdout",
    `[paperclip] Removed stale Codex auth lock for "${realAuthPath}".\n`,
  );
  return true;
}

async function acquireCodexAuthLock(
  codexHome: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<(() => Promise<void>) | null> {
  const lock = await resolveCodexAuthLock(codexHome);
  if (!lock) return null;

  await fs.mkdir(LOCK_ROOT, { recursive: true, mode: 0o700 });

  const startedAt = Date.now();
  let loggedWait = false;
  for (;;) {
    try {
      await fs.mkdir(lock.lockDir, { mode: 0o700 });
      await fs.writeFile(
        path.join(lock.lockDir, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          authPath: lock.realAuthPath,
        }),
      ).catch(() => undefined);

      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lock.lockDir, now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();

      if (loggedWait) {
        await onLog(
          "stdout",
          `[paperclip] Acquired Codex auth lock for "${lock.realAuthPath}" after ${Date.now() - startedAt}ms.\n`,
        );
      }

      return async () => {
        clearInterval(heartbeat);
        await fs.rm(lock.lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (err) {
      if (!isRecord(err) || err.code !== "EEXIST") throw err;

      if (!loggedWait) {
        loggedWait = true;
        await onLog(
          "stdout",
          `[paperclip] Waiting for Codex auth lock for "${lock.realAuthPath}".\n`,
        );
      }

      await removeStaleLock(lock.lockDir, lock.realAuthPath, onLog);
      await sleep(LOCK_POLL_MS);
    }
  }
}

export async function withCodexAuthLock<T>(
  codexHome: string,
  onLog: AdapterExecutionContext["onLog"],
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireCodexAuthLock(codexHome, onLog);
  try {
    return await run();
  } finally {
    await release?.();
  }
}
