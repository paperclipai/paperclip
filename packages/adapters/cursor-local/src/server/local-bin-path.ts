import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Ensures `~/.local/bin` is on PATH (default install for `curl https://cursor.com/install | bash`).
 * Appended when missing so explicit adapter `env.PATH` entries (e.g. tests or custom bins) keep priority.
 */
export function ensureUserLocalBinOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const localBin = path.join(os.homedir(), ".local", "bin");
  try {
    if (!fs.existsSync(localBin) || !fs.statSync(localBin).isDirectory()) return env;
  } catch {
    return env;
  }
  const sep = path.delimiter;
  const absLocal = path.resolve(localBin);
  const key: "PATH" | "Path" | null =
    typeof env.PATH === "string" ? "PATH" : typeof env.Path === "string" ? "Path" : null;
  if (!key) {
    return { ...env, PATH: localBin };
  }
  const val = env[key]!;
  if (val.length === 0) {
    return { ...env, [key]: localBin };
  }
  for (const part of val.split(sep)) {
    if (part && path.resolve(part) === absLocal) return env;
  }
  return { ...env, [key]: `${val}${sep}${localBin}` };
}
