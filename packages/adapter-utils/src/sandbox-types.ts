export interface SandboxExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  stdin?: string;
  onStdout?: (chunk: string) => Promise<void> | void;
  onStderr?: (chunk: string) => Promise<void> | void;
}

export interface SandboxInstanceStatus {
  status: "running" | "stopped" | "error";
  endpoint?: string | null;
}

export interface SandboxInstance {
  id: string;
  exec(command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  status(): Promise<SandboxInstanceStatus>;
  destroy(): Promise<void>;
}

export interface SandboxCreateOptions {
  sandboxId: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
  image?: string;
  instanceType?: string;
  timeoutSec?: number;
}

export interface SandboxTestResult {
  ok: boolean;
  detail?: string | null;
}

export interface SandboxProvider {
  type: string;
  create(opts: SandboxCreateOptions): Promise<SandboxInstance>;
  reconnect(id: string): Promise<SandboxInstance>;
  testConnection(config: Record<string, unknown>): Promise<SandboxTestResult>;
}
