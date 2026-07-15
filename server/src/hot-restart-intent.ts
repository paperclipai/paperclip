import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "./home-paths.js";

const MAX_INTENT_BYTES = 16 * 1024;
const MAX_INTENT_AGE_MS = 5 * 60 * 1000;

export type HotRestartIntent = {
  version: 1;
  requestedAt: string;
  serverPid: number;
};

export function getHotRestartIntentPath() {
  return path.join(resolvePaperclipHomeDir(), "hot-restart-intent.json");
}

export function writeHotRestartIntent(
  now = new Date(),
  serverPid = process.pid,
): HotRestartIntent {
  const intent: HotRestartIntent = {
    version: 1,
    requestedAt: now.toISOString(),
    serverPid,
  };
  const filePath = getHotRestartIntentPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return intent;
}

export function consumeHotRestartIntent(
  now = new Date(),
  serverPid = process.pid,
): HotRestartIntent | null {
  const filePath = getHotRestartIntentPath();
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_INTENT_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<HotRestartIntent>;
    const requestedAt = typeof parsed.requestedAt === "string" ? new Date(parsed.requestedAt) : null;
    if (
      parsed.version !== 1 ||
      parsed.serverPid !== serverPid ||
      !requestedAt ||
      !Number.isFinite(requestedAt.getTime()) ||
      now.getTime() - requestedAt.getTime() < 0 ||
      now.getTime() - requestedAt.getTime() > MAX_INTENT_AGE_MS
    ) {
      return null;
    }
    return parsed as HotRestartIntent;
  } catch {
    return null;
  } finally {
    rmSync(filePath, { force: true });
  }
}
