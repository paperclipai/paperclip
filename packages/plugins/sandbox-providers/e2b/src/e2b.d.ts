declare module "e2b" {
  export class CommandExitError extends Error {
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  export class SandboxNotFoundError extends Error {}
  export class TimeoutError extends Error {}

  export interface SandboxRunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  export interface SandboxBackgroundHandle {
    pid: number;
    stdout: string;
    stderr: string;
    wait(): Promise<SandboxRunResult>;
  }

  export class Sandbox {
    sandboxId: string;
    sandboxDomain?: string;
    static create(
      templateOrOptions?: string | Record<string, unknown>,
      maybeOptions?: Record<string, unknown>,
    ): Promise<Sandbox>;
    static connect(
      sandboxId: string,
      options?: Record<string, unknown>,
    ): Promise<Sandbox>;
    setTimeout(timeoutMs: number): Promise<void>;
    kill(): Promise<void>;
    pause(): Promise<void>;
    commands: {
      run(
        command: string,
        options?: {
          background?: boolean;
          stdin?: boolean;
          cwd?: string;
          envs?: Record<string, string>;
          timeoutMs?: number;
        },
      ): Promise<SandboxRunResult | SandboxBackgroundHandle>;
      sendStdin(pid: number, input: string): Promise<void>;
      closeStdin(pid: number): Promise<void>;
    };
  }
}
