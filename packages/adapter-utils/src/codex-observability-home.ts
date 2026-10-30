import { chmod, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";
import type { ProviderObservabilityLaunch } from "./agent-observability.js";

/** ACPX starts app-server: its config must be private to this settings snapshot.
 * Conversation files stay in the stable managed home; no export config is
 * written there or included in the logical session fingerprint.
 */
export async function prepareAcpxCodexObservabilityHome(home: string, launch: ProviderObservabilityLaunch, agentId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId) || !/^[A-Za-z0-9_-]{1,128}$/.test(launch.compatibilityKey) || launch.kind !== "codex" || !launch.otelConfig) {
    throw new Error("Invalid Codex observability launch");
  }
  const parent = path.join(home, "paperclip-observability");
  // Subscription agents share the company home and compatibility key, but
  // their resource attributes differ. Never let their configs share a file.
  const owner = path.join(parent, agentId);
  const target = path.join(owner, launch.compatibilityKey);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700); await chmod(owner, 0o700); await chmod(target, 0o700);
  async function atomicFile(name: string, contents: string | Buffer) {
    const temporary = path.join(target, `.${name}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
      await rename(temporary, path.join(target, name));
      await chmod(path.join(target, name), 0o600);
    } finally { await rm(temporary, { force: true }); }
  }
  // Preserve the existing managed credential link. Codex refreshes this file
  // in place; a launch-owned copy would lose the rotated token on preparation.
  const authLink = path.join(target, "auth.json");
  const temporaryAuthLink = path.join(target, `.auth-${randomUUID()}.tmp`);
  try {
    await symlink(path.join(home, "auth.json"), temporaryAuthLink, "file");
    await rename(temporaryAuthLink, authLink);
  } finally { await rm(temporaryAuthLink, { force: true }); }
  for (const name of ["config.json", "instructions.md"]) {
    try { await atomicFile(name, await readFile(path.join(home, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const name of ["sessions", "archived_sessions", "skills"]) {
    const source = path.join(home, name);
    await mkdir(source, { recursive: true });
    const link = path.join(target, name);
    try { await symlink(source, link, "dir"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readlink(link) !== source) throw error;
    }
  }
  const source = await readFile(path.join(home, "config.toml"), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error;
  });
  const current = parse(source);
  const features = current.features && typeof current.features === "object" && !Array.isArray(current.features) ? current.features : {};
  await atomicFile("config.toml", stringify({ ...current, otel: launch.otelConfig, features: { ...features, shell_snapshot: false } }));
  return target;
}
