#!/usr/bin/env node
/**
 * Cross-platform entry: Windows -> kill-dev.ps1, Unix -> kill-dev.sh
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    ...opts,
  });
  if (r.error) {
    return { ok: false, status: 1, error: r.error };
  }
  return { ok: true, status: r.status ?? 0 };
}

const forward = process.argv.slice(2);

if (process.platform === "win32") {
  const ps1 = path.join(root, "scripts", "kill-dev.ps1");
  let r = run("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...forward]);
  if (!r.ok || (r.status !== 0 && r.status !== null)) {
    r = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...forward]);
  }
  process.exit(r.status ?? 1);
}

const sh = path.join(root, "scripts", "kill-dev.sh");
const r = run("bash", [sh, ...forward]);
process.exit(r.status ?? 1);
