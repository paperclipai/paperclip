import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import {
  ensurePathInEnv,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";

type JsonRpcId = string | number;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcError = {
  code?: number | string;
  message?: string;
  data?: unknown;
};

export class CodexAppServerError extends Error {
  code: number | string | null;
  data: unknown;

  constructor(message: string, options: { code?: number | string | null; data?: unknown } = {}) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = options.code ?? null;
    this.data = options.data;
  }
}

export interface CodexAppServerTransportOptions {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  rpcTimeoutMs?: number;
  onStdoutEvent: (event: Record<string, unknown>) => void;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}

function jsonRpcErrorMessage(error: JsonRpcError, fallback: string): string {
  const message = typeof error.message === "string" && error.message.trim().length > 0
    ? error.message.trim()
    : fallback;
  return typeof error.code === "number" || typeof error.code === "string"
    ? `${message} (${error.code})`
    : message;
}

function processGroupIdFor(child: ChildProcessWithoutNullStreams): number | null {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}

function signalChild(child: ChildProcessWithoutNullStreams, processGroupId: number | null, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && processGroupId && processGroupId > 0) {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch {
      // Fall back to direct child signaling when the group already exited.
    }
  }
  if (!child.killed) child.kill(signal);
}

function approvalDeclineResult(method: string) {
  return {
    approved: false,
    decision: "deny",
    outcome: "denied",
    reason: `Paperclip declined ${method}; Codex app-server runs are non-interactive.`,
  };
}

function userInputDeclineResult(method: string) {
  return {
    canceled: true,
    cancelled: true,
    response: null,
    answer: null,
    reason: `Paperclip declined ${method}; Codex app-server runs cannot request interactive input.`,
  };
}

function isApprovalRequest(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestApproval" ||
    /\/requestApproval$/i.test(method)
  );
}

function isUserInputRequest(method: string): boolean {
  return (
    method === "item/tool/requestUserInput" ||
    method === "elicitation/requestInput" ||
    method === "elicitation/create" ||
    /(?:requestUserInput|elicitation)/i.test(method)
  );
}

export class CodexAppServerTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private processGroupId: number | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private stdout = "";
  private stderr = "";
  private closed = false;
  private closeCode: number | null = null;
  private closeSignal: string | null = null;
  private readonly rpcTimeoutMs: number;

  constructor(private readonly options: CodexAppServerTransportOptions) {
    this.rpcTimeoutMs = Math.max(1_000, options.rpcTimeoutMs ?? 20_000);
  }

  get capturedStdout(): string {
    return this.stdout;
  }

  get capturedStderr(): string {
    return this.stderr;
  }

  get signal(): string | null {
    return this.closeSignal;
  }

  async start(): Promise<void> {
    const mergedEnv = ensurePathInEnv({
      ...sanitizeInheritedPaperclipEnv(process.env),
      ...this.options.env,
    });
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: mergedEnv,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.processGroupId = processGroupIdFor(child);
    const startedAt = new Date().toISOString();
    if (typeof child.pid === "number" && child.pid > 0) {
      await this.options.onSpawn?.({ pid: child.pid, processGroupId: this.processGroupId, startedAt });
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      this.stdout += `${line}\n`;
      this.handleLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderr += text;
      void this.options.onLog("stderr", text);
    });
    child.on("close", (code, signal) => {
      this.closed = true;
      this.closeCode = code;
      this.closeSignal = signal;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Codex app-server exited while waiting for ${pending.method}: ${signal ?? code ?? "unknown"}`));
        this.pending.delete(id);
      }
    });
    child.on("error", (error) => {
      this.closed = true;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    });
  }

  async request(method: string, params?: unknown, timeoutMs = this.rpcTimeoutMs): Promise<unknown> {
    if (!this.child || this.closed) {
      throw new Error(`Cannot call ${method}; Codex app-server is not running.`);
    }
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(String(id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(String(id));
        pending.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    const payload = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (!done()) {
      if (this.closed) {
        if (this.closeCode === 0 || done()) return;
        throw new Error(`Codex app-server exited with ${this.closeSignal ?? this.closeCode ?? "unknown"}`);
      }
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out after ${Math.ceil(timeoutMs / 1000)}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.child || this.closed) return;
    signalChild(this.child, this.processGroupId, signal);
  }

  async stopWithGrace(graceMs: number): Promise<void> {
    if (!this.child || this.closed) return;
    this.stop("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.closed) this.stop("SIGKILL");
        resolve();
      }, Math.max(100, graceMs));
      this.child?.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      void this.options.onLog("stdout", `${line}\n`);
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      void this.options.onLog("stdout", `${line}\n`);
      return;
    }
    const rpc = message as Record<string, unknown>;
    const id = rpc.id;
    const method = typeof rpc.method === "string" ? rpc.method : "";
    if ((typeof id === "string" || typeof id === "number") && method) {
      this.answerServerRequest(id, method);
      return;
    }
    if (typeof id === "string" || typeof id === "number") {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(id));
      const error = rpc.error;
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        pending.reject(new CodexAppServerError(
          jsonRpcErrorMessage(error as JsonRpcError, `${pending.method} failed`),
          {
            code: (error as JsonRpcError).code ?? null,
            data: (error as JsonRpcError).data,
          },
        ));
      } else {
        pending.resolve(rpc.result);
      }
      return;
    }
    if (method) this.options.onStdoutEvent(rpc);
  }

  private answerServerRequest(id: JsonRpcId, method: string): void {
    if (!this.child || this.closed) return;
    if (isApprovalRequest(method)) {
      this.child.stdin.write(`${JSON.stringify({ id, result: approvalDeclineResult(method) })}\n`);
      return;
    }
    if (isUserInputRequest(method)) {
      this.child.stdin.write(`${JSON.stringify({ id, result: userInputDeclineResult(method) })}\n`);
      return;
    }
    this.child.stdin.write(`${JSON.stringify({
      id,
      error: {
        code: -32601,
        message: `Unsupported Codex app-server request method: ${method}`,
      },
    })}\n`);
  }
}
