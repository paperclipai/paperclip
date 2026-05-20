import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { shellQuote } from "./helpers.js";
import { isTimeoutError } from "./sandboxes.js";
import { cleanupTimedOutExecution, resolveExecutionTarget, type SessionStrategy } from "./sessions.js";

export interface BridgeExecuteParams {
  sandbox: CloudflareSandbox;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  sessionStrategy: SessionStrategy;
  sessionId?: string;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void | Promise<void>;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function randomToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length > 0) return uuid.replace(/[^a-zA-Z0-9-]/g, "");
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinFile?: string | null;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }

  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const stdinRedirect = input.stdinFile ? ` < ${shellQuote(input.stdinFile)}` : "";
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  const execLine = envArgs.length > 0
    ? `exec env ${envArgs.join(" ")} ${commandParts}${stdinRedirect}`
    : `exec ${commandParts}${stdinRedirect}`;
  lines.push(execLine);
  return lines.join(" && ");
}

function coerceExecuteResult(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) {
  return {
    exitCode:
      typeof result.exitCode === "number" || result.exitCode === null
        ? result.exitCode
        : result.success === false
          ? 1
          : 0,
    signal: null,
    timedOut: false,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function executeInSandbox(params: BridgeExecuteParams) {
  // The @cloudflare/sandbox SDK's exec() takes a single command string and a
  // narrow option set ({ cwd, env, timeout, ... }) — it does not accept `args`
  // or `stdin`. We compose the full shell command ourselves and stage stdin
  // through a temp file in the sandbox when the caller provides one.
  const stdinPayload = typeof params.stdin === "string" && params.stdin.length > 0
    ? params.stdin
    : null;
  const stdinFile = stdinPayload ? `/tmp/.paperclip-bridge-stdin-${randomToken()}` : null;

  if (stdinFile && stdinPayload) {
    await params.sandbox.writeFile(stdinFile, stdinPayload, { encoding: "utf8" });
  }

  try {
    const target = await resolveExecutionTarget(params.sandbox, {
      sessionStrategy: params.sessionStrategy,
      sessionId: params.sessionId,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
    const script = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdinFile,
    });
    const fullCommand = `sh -lc ${shellQuote(script)}`;
    const result = await target.exec(fullCommand, {
      cwd: "/",
      timeout: params.timeoutMs,
      ...(typeof params.onOutput === "function"
        ? {
            stream: true,
            onOutput: params.onOutput,
          }
        : {}),
    });
    return coerceExecuteResult(result);
  } catch (error) {
    if (isTimeoutError(error)) {
      await cleanupTimedOutExecution(params.sandbox, {
        sessionStrategy: params.sessionStrategy,
        sessionId: params.sessionId,
      });
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    throw error;
  } finally {
    if (stdinFile) {
      await params.sandbox.deleteFile?.(stdinFile).catch(() => undefined);
    }
  }
}
