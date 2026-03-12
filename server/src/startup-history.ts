import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type LaunchContext = {
  launchId: string;
  command: string;
  cwd: string;
  repoPath: string;
  paperclipHome: string;
  instanceId: string;
  configPath: string;
  startupSource: string;
};

type StartupDatabaseInfo =
  | { mode: "embedded-postgres"; dataDir: string; port: number }
  | { mode: "external-postgres"; connectionString: string };

function parseLaunchContext(): LaunchContext | null {
  const raw = process.env.PAPERCLIP_LAUNCH_CONTEXT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LaunchContext>;
    if (
      typeof parsed.launchId !== "string" ||
      typeof parsed.command !== "string" ||
      typeof parsed.cwd !== "string" ||
      typeof parsed.repoPath !== "string" ||
      typeof parsed.paperclipHome !== "string" ||
      typeof parsed.instanceId !== "string" ||
      typeof parsed.configPath !== "string" ||
      typeof parsed.startupSource !== "string"
    ) {
      return null;
    }
    return parsed as LaunchContext;
  } catch {
    return null;
  }
}

function redactConnectionString(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.username || "user"}:***@${url.host}${url.pathname}`;
  } catch {
    return "<invalid connection string>";
  }
}

function databaseRef(db: StartupDatabaseInfo): string {
  return db.mode === "embedded-postgres" ? db.dataDir : redactConnectionString(db.connectionString);
}

/**
 * The root startup scripts persist repo-local preflight choices; the server
 * records the actual ready event once it has a bound port and a live database.
 */
export async function recordStartupReady(input: {
  db: StartupDatabaseInfo;
  listenHost: string;
  listenPort: number;
}) {
  const context = parseLaunchContext();
  const historyFile = process.env.PAPERCLIP_LAUNCH_HISTORY_FILE;
  if (!context || !historyFile) return;

  await mkdir(path.dirname(historyFile), { recursive: true });
  await appendFile(
    historyFile,
    `${JSON.stringify({
      ...context,
      recordedAt: new Date().toISOString(),
      databaseRef: databaseRef(input.db),
      listenHost: input.listenHost,
      listenPort: input.listenPort,
      result: "ready",
      failureMessage: null,
    })}\n`,
  );

  const readyFile = process.env.PAPERCLIP_LAUNCH_READY_FILE;
  if (readyFile) {
    await mkdir(path.dirname(readyFile), { recursive: true });
    await writeFile(
      readyFile,
      JSON.stringify({
        launchId: context.launchId,
        readyAt: new Date().toISOString(),
      }),
    );
  }
}
