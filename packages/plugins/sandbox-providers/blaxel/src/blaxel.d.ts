declare module "@blaxel/core" {
  export function initialize(config: {
    workspace?: string;
    apiKey?: string;
  }): void;

  export interface ExpirationPolicy {
    type?: "ttl-idle" | "ttl-max-age" | "date";
    action?: "delete";
    value?: string;
  }

  export interface SandboxLifecycle {
    expirationPolicies?: ExpirationPolicy[];
    terminatedRetention?: string;
  }

  export interface SandboxCreateConfiguration {
    name?: string;
    image?: string;
    memory?: number;
    region?: string;
    ttl?: string;
    lifecycle?: SandboxLifecycle;
    labels?: Record<string, string>;
  }

  export class SandboxInstance {
    get metadata(): { name?: string };
    get status(): string;
    get spec(): { region?: string; runtime?: { image?: string; memory?: number } };

    fs: {
      ls(path: string): Promise<unknown>;
    };

    process: {
      exec(request: {
        command: string;
        env?: Record<string, string>;
        workingDir?: string;
        waitForCompletion?: boolean;
        timeout?: number;
      }): Promise<{
        pid: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        status: string;
      }>;
    };

    delete(): Promise<unknown>;

    static create(
      config?: SandboxCreateConfiguration,
      options?: { safe?: boolean },
    ): Promise<SandboxInstance>;

    static get(name: string): Promise<SandboxInstance>;

    static delete(name: string): Promise<unknown>;
  }
}
