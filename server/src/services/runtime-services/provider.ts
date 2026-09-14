import type { RuntimeServiceLaunchSpec } from "@paperclipai/shared";

export interface RuntimeServiceProcessRef {
  generation: string;
  [key: string]: unknown;
}

export interface RuntimeServiceProviderContext {
  companyId: string;
  serviceId: string;
  allocationId: string;
  environmentLeaseId?: string | null;
  allocationMetadata: Record<string, unknown>;
  spec: RuntimeServiceLaunchSpec;
  env: Record<string, string>;
  secrets: string[];
  process: RuntimeServiceProcessRef;
}

export interface RuntimeServiceProvider {
  readonly key: string;
  readonly capabilities: {
    dynamicPorts: boolean;
    preview: boolean;
    logs: boolean;
    preservesDataOnStop: boolean;
  };
  /** Server-verified capture; the actor only supplies a numeric source PID. */
  captureExistingProcess?(input: {
    pid: number;
    owner: { pid: number; startedAt: string };
    cwd: string;
    workspaceRoot: string;
    environmentLeaseId?: string | null;
    authority?: { companyId: string; runId: string };
  }): Promise<{ key: string; receipt: Record<string, unknown> }>;
  /** Must confirm the original group is gone before a new generation can start. */
  stopExistingProcess?(receipt: Record<string, unknown>, authority?: { companyId: string; serviceId: string }): Promise<void>;
  /** Idempotent by service + persisted generation, including controller recovery. */
  start(context: RuntimeServiceProviderContext): Promise<RuntimeServiceProcessRef>;
  inspect(context: RuntimeServiceProviderContext): Promise<{
    state: "running" | "exited" | "missing";
    processRef?: RuntimeServiceProcessRef;
    exitCode?: number | null;
    endpoints: Array<{ name: string; port: number; healthy: boolean }>;
  }>;
  /** Also fences a not-yet-started generation against a late controller launch. */
  stop(context: RuntimeServiceProviderContext): Promise<void>;
  logs(context: RuntimeServiceProviderContext, limitBytes: number): Promise<string>;
  upstream?(context: RuntimeServiceProviderContext, endpointName: string): Promise<{ url: string; headers: Record<string, string> }>;
  retainAllocation?(context: RuntimeServiceProviderContext): Promise<void>;
  releaseCompute?(context: RuntimeServiceProviderContext): Promise<"stopped" | "retained">;
  /** Read-only measurement; never resume stopped compute for this request. */
  storageUsage?(context: RuntimeServiceProviderContext): Promise<{ bytes: number } | { unavailable: "compute_stopped" | "measurement_failed" }>;
}
