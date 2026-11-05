import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveTranscriptConfigDir(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = os.homedir(),
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const config = env.CLAUDE_CONFIG_DIR?.trim();
  if (config) return paths.resolve(cwd, config);
  const home = (platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim()) || fallbackHome;
  return paths.resolve(cwd, home, ".claude");
}

export function createTranscriptProbe(
  inspect: (file: string) => Promise<boolean | null>,
  limit = 4,
  timeoutMs = 500,
): (file: string) => Promise<boolean | null> {
  const pending = new Map<string, Promise<boolean | null>>();
  return async (file) => {
    let operation = pending.get(file);
    if (!operation) {
      if (pending.size >= limit) return null;
      operation = Promise.resolve().then(() => inspect(file)).catch(() => null);
      pending.set(file, operation);
      void operation.finally(() => pending.delete(file));
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

const probeTranscript = createTranscriptProbe(async (key) => {
  const input = JSON.parse(key) as { configDir: string; cwd: string; sessionId: string };
  let cwd = input.cwd;
  if (process.platform !== "win32") {
    try {
      cwd = await fs.realpath(cwd);
    } catch {
      return null;
    }
  }
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  const file = path.join(input.configDir, "projects", encodedCwd, `${input.sessionId}.jsonl`);
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : null;
  }
});

export function probeClaudeTranscript(input: { configDir: string; cwd: string; sessionId: string }): Promise<boolean | null> {
  return probeTranscript(JSON.stringify(input));
}
