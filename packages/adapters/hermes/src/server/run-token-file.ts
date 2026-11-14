import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RESTORE_INTERVAL_MS = 30_000;

export interface RunTokenFile {
  path: string;
  stop: () => Promise<void>;
}

async function isPrivateDirectory(dir: string): Promise<boolean> {
  const stat = await fs.lstat(dir);
  return (
    stat.isDirectory() &&
    (stat.mode & 0o777) === 0o700 &&
    (process.getuid === undefined || stat.uid === process.getuid())
  );
}

export async function startRunTokenFile(
  token: string,
  options: { restoreIntervalMs?: number } = {},
): Promise<RunTokenFile> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-run-"));
  const file = path.join(dir, "token");
  const write = () => fs.writeFile(file, token, { mode: 0o600, flag: "wx" });

  try {
    await write();
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  const restore = async () => {
    await fs.mkdir(dir, { mode: 0o700 }).catch(() => undefined);
    if (await isPrivateDirectory(dir)) await write();
  };

  let restoring: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (restoring) return;
    restoring = restore()
      .catch(() => undefined)
      .finally(() => {
        restoring = null;
      });
  }, options.restoreIntervalMs ?? RESTORE_INTERVAL_MS);
  timer.unref();

  return {
    path: file,
    stop: async () => {
      clearInterval(timer);
      await restoring;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildRunTokenGuidance(tokenPath: string): string {
  return [
    "Paperclip secrets guidance:",
    "- Hermes may run tools outside this run's process, so `$PAPERCLIP_API_KEY` in your shell can differ from this run's token.",
    "- `/api/agents/me/secrets` accepts only this run's token. Send it on those routes:",
    `  \`-H "Authorization: Bearer $(cat ${shellQuote(tokenPath)})"\``,
    "- Do not print, store or copy this token or any secret value. The file is removed when this run ends.",
  ].join("\n");
}
