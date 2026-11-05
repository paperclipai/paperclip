import fs from "node:fs";
import path from "node:path";
import { packageVersion } from "./version.js";
import { compareVersions } from "./commands/update.js";
import { readInstallManifest, resolveInstallStorePaths } from "./install-store.js";
import { resolveConfigPath } from "./config/store.js";
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export function isUpdateNoticeEnabled(configPath?: string): boolean {
  if (process.env.PAPERCLIP_UPDATE_CHECK === "0") return false;
  try { const raw = JSON.parse(fs.readFileSync(resolveConfigPath(configPath), "utf8")) as { updates?: { checkEnabled?: boolean } }; return raw.updates?.checkEnabled !== false; } catch { return true; }
}
export async function checkForUpdateNotice(options: { configPath?: string; now?: number; fetchImpl?: typeof fetch; cachePath?: string } = {}): Promise<string | null> {
  if (!isUpdateNoticeEnabled(options.configPath)) return null;
  const paths = resolveInstallStorePaths(); const cachePath = options.cachePath ?? path.join(paths.cliRoot, "update-check.json"); const now = options.now ?? Date.now();
  try { const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { checkedAt?: number; latest?: string }; if (cache.checkedAt && now - cache.checkedAt < NOTICE_INTERVAL_MS) return cache.latest && compareVersions(cache.latest, packageVersion) > 0 ? cache.latest : null; } catch {}
  const tag = readInstallManifest(paths)?.channel === "canary" ? "canary" : "latest";
  try { const response = await (options.fetchImpl ?? fetch)("https://registry.npmjs.org/paperclipai", { signal: AbortSignal.timeout(2500) }); if (!response.ok) return null; const body = await response.json() as { ["dist-tags"]?: Record<string, string> }; const latest = body["dist-tags"]?.[tag]; fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 }); fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: now, latest: latest ?? null }) + "\n", { mode: 0o600 }); return latest && compareVersions(latest, packageVersion) > 0 ? latest : null; } catch { return null; }
}
export async function printUpdateNotice(configPath?: string): Promise<void> { const latest = await checkForUpdateNotice({ configPath }); if (latest) console.log(`Update available: ${latest} — run \`paperclipai update\``); }
