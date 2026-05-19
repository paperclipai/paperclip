import { runningProcesses, killWindowsProcessTree } from "@paperclipai/adapter-utils/server-utils";

export type CodeBuddyFatalStop = {
  errorMessage: string;
  errorCode: string;
};

type FatalPattern = {
  re: RegExp;
  errorMessage: string | ((match: RegExpMatchArray) => string);
  errorCode: string;
};

const STDERR_FATAL_PATTERNS: FatalPattern[] = [
  {
    re: /authentication\s+required|not\s+authenticated|not\s+logged\s+in|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?/i,
    errorMessage: "CodeBuddy 未通过认证，无头模式无法继续。请配置密钥或执行 agent login。",
    errorCode: "codebuddy_auth_required",
  },
  {
    re: /max\s+turns?\s*\(\d+\)\s+exceeded/i,
    errorMessage: (match) => `CodeBuddy 已达最大轮次限制：${match[0]}`,
    errorCode: "codebuddy_max_turns_exceeded",
  },
  {
    re: /rate\s+limit|quota\s+exceeded|insufficient\s+(quota|balance|funds)/i,
    errorMessage: "CodeBuddy 配额或速率受限，本次运行已停止。",
    errorCode: "codebuddy_quota_exceeded",
  },
  {
    re: /ENOMEM|out\s+of\s+memory|JavaScript heap out of memory/i,
    errorMessage: "CodeBuddy 进程内存不足，本次运行已停止。",
    errorCode: "codebuddy_resource_exhausted",
  },
  {
    re: /FATAL ERROR|Segmentation fault|STATUS_DLL_INIT_FAILED/i,
    errorMessage: "CodeBuddy 进程崩溃，本次运行已停止。",
    errorCode: "codebuddy_process_crashed",
  },
];

function signalRunningProcess(
  running: { child: { killed?: boolean; pid?: number | undefined; kill: (signal?: NodeJS.Signals) => void } },
  processGroupId: number | null,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && processGroupId && processGroupId > 0) {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch {
      // fall through
    }
  }
  if (running.child.killed) return;
  const pid = running.child.pid;
  if (process.platform === "win32" && signal === "SIGKILL") {
    if (pid && pid > 0) killWindowsProcessTree(pid);
    return;
  }
  try {
    running.child.kill(signal);
  } catch {
    if (process.platform === "win32" && pid && pid > 0) killWindowsProcessTree(pid);
  }
  if (process.platform === "win32" && pid && pid > 0) killWindowsProcessTree(pid);
}

/** Terminate the child registered for a Paperclip run id (best-effort). */
export function terminateRunningChildProcess(
  runId: string,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  const running = runningProcesses.get(runId);
  if (!running) return false;
  signalRunningProcess(running, running.processGroupId, signal);
  return true;
}

function formatFatalPatternMatch(pattern: FatalPattern, match: RegExpMatchArray): CodeBuddyFatalStop {
  const errorMessage =
    typeof pattern.errorMessage === "function" ? pattern.errorMessage(match) : pattern.errorMessage;
  return { errorMessage, errorCode: pattern.errorCode };
}

export function inspectCodeBuddyStderrLine(line: string): CodeBuddyFatalStop | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const pattern of STDERR_FATAL_PATTERNS) {
    const match = trimmed.match(pattern.re);
    if (match) return formatFatalPatternMatch(pattern, match);
  }
  return null;
}

export function inspectCodeBuddyStreamJsonLine(line: string): CodeBuddyFatalStop | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== "result") return null;
  const subtype = typeof obj.subtype === "string" ? obj.subtype.toLowerCase() : "";
  const isError = obj.is_error === true || subtype === "error" || subtype === "failure";
  if (!isError) return null;
  const detail =
    typeof obj.result === "string" && obj.result.trim().length > 0
      ? obj.result.trim()
      : "CodeBuddy 返回错误结果，无头模式无法在同一次运行内恢复。";
  return {
    errorMessage: detail,
    errorCode: "codebuddy_execution_error",
  };
}

function splitBufferedLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = `${buffer}${chunk}`;
  const parts = combined.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export function createCodeBuddyStreamLogHandler(input: {
  runId: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  graceSec: number;
}): {
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  flush: () => Promise<void>;
  getFatalStop: () => CodeBuddyFatalStop | null;
} {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let fatalStop: CodeBuddyFatalStop | null = null;
  let terminateScheduled = false;

  const scheduleTerminate = () => {
    if (terminateScheduled || fatalStop) return;
    terminateScheduled = true;
    const graceMs = Math.max(1, input.graceSec) * 1000;
    terminateRunningChildProcess(input.runId, "SIGTERM");
    setTimeout(() => {
      terminateRunningChildProcess(input.runId, "SIGKILL");
    }, graceMs).unref?.();
  };

  const inspectLine = (stream: "stdout" | "stderr", line: string) => {
    if (fatalStop) return;
    const hit =
      stream === "stderr" ? inspectCodeBuddyStderrLine(line) : inspectCodeBuddyStreamJsonLine(line);
    if (!hit) return;
    fatalStop = hit;
    scheduleTerminate();
  };

  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    await input.onLog(stream, chunk);
    if (fatalStop) return;
    if (stream === "stderr") {
      const split = splitBufferedLines(stderrBuffer, chunk);
      stderrBuffer = split.rest;
      for (const line of split.lines) inspectLine("stderr", line);
      return;
    }
    const split = splitBufferedLines(stdoutBuffer, chunk);
    stdoutBuffer = split.rest;
    for (const line of split.lines) inspectLine("stdout", line);
  };

  const flush = async () => {
    if (stdoutBuffer.trim()) inspectLine("stdout", stdoutBuffer);
    if (stderrBuffer.trim()) inspectLine("stderr", stderrBuffer);
    stdoutBuffer = "";
    stderrBuffer = "";
  };

  return {
    onLog,
    flush,
    getFatalStop: () => fatalStop,
  };
}
