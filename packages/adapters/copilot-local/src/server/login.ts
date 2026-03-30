import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

export async function runCopilotLogin(input: {
  runId: string;
  agent: { id: string; companyId: string; name: string; adapterType: string; adapterConfig: unknown };
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const onLog = input.onLog ?? (async () => {});
  const config = input.config;
  const command = asString(config.command, "copilot");
  const cwd = asString(config.cwd, process.cwd());
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(input.agent as AdapterExecutionContext["agent"]) };
  env.PAPERCLIP_RUN_ID = input.runId;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (input.authToken) {
    env.PAPERCLIP_API_KEY = input.authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = 120; // generous timeout for OAuth device flow
  const graceSec = 10;

  const proc = await runChildProcess(input.runId, command, ["login"], {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
}
