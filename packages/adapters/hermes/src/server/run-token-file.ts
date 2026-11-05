import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RESTORE_INTERVAL_MS = 30_000;

export interface RunTokenFile {
  path: string;
  stop: () => Promise<void>;
}

export async function startRunTokenFile(
  token: string,
  options: { restoreIntervalMs?: number } = {},
): Promise<RunTokenFile> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-run-"));
  const file = path.join(dir, "token");
  const write = () => fs.writeFile(file, token, { mode: 0o600 });
  await write();

  const timer = setInterval(() => {
    void fs
      .mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => fs.access(file).catch(write))
      .catch(() => undefined);
  }, options.restoreIntervalMs ?? RESTORE_INTERVAL_MS);
  timer.unref();

  return {
    path: file,
    stop: async () => {
      clearInterval(timer);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function buildRunTokenGuidance(tokenPath: string): string {
  return [
    "Paperclip secrets guidance:",
    "- Hermes may run tools outside this run's process, so `$PAPERCLIP_API_KEY` in your shell can differ from this run's token.",
    "- `/api/agents/me/secrets` accepts only this run's token. Send it on those routes:",
    `  \`-H "Authorization: Bearer $(cat ${tokenPath})"\``,
    "- Do not print, store or copy this token or any secret value. The file is removed when this run ends.",
  ].join("\n");
}
