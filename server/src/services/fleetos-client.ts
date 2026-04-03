/**
 * Server-side FleetOS API client for the dashboard proxy layer.
 *
 * Reads FleetOS URL from the FLEETOS_API_URL environment variable and accepts
 * an API key per-request (sourced from the agent's adapter config by the caller).
 *
 * This is intentionally separate from the adapter's FleetOSClient to avoid
 * importing adapter packages in the server.
 */

// ---------------------------------------------------------------------------
// Types (mirrored from the adapter shared types — no cross-package import)
// ---------------------------------------------------------------------------

// --- Templates ---

export interface FleetTemplate {
  name: string;
  label: string;
  description?: string;
}

export interface FleetTemplateField {
  name: string;
  label: string;
  type: "string" | "select" | "boolean" | "number" | "text";
  required: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  description?: string;
  group?: string;
}

export interface FleetTemplateDetail extends FleetTemplate {
  fields: FleetTemplateField[];
  default_memory?: string;
  default_cpu?: string;
  default_disk?: string;
}

// --- Provisioning ---

export interface ProvisionValidateRequest {
  template: string;
  tenant_id: string;
  agent_name: string;
  agent_role: string;
  model?: string;
  memory?: string;
  cpu?: string;
  disk?: string;
  extra_fields?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProvisionValidateResponse {
  valid: boolean;
  container_name?: string;
  checks?: { name: string; status: string; detail?: string }[];
  errors?: string[];
  warnings?: string[];
}

export interface ProvisionRequest extends ProvisionValidateRequest {
  test?: boolean;
}

export interface ProvisionJob {
  id: string;
  status: "running" | "complete" | "failed" | "cancelled" | "timeout";
  template: string;
  tenant_id: string;
  agent_name: string;
  container_name?: string;
  steps?: { name: string; status: string; detail?: string; started_at?: string; completed_at?: string }[];
  result?: Record<string, unknown>;
  error?: string;
  created_at?: string;
  completed_at?: string;
}

// --- Containers ---

export interface FleetContainer {
  id: string;
  name: string;
  status: "running" | "stopped" | "frozen" | "error" | "provisioning";
  tenant_id: string;
  image: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  ip_address: string | null;
  labels: Record<string, string>;
}

export interface FleetHealth {
  container_id: string;
  cpu_percent: number;
  mem_percent: number;
  disk_percent: number;
  agent_status: "idle" | "busy" | "error" | "offline";
  uptime_seconds: number;
  last_heartbeat: string;
}

export interface FleetAgentProcess {
  pid: number | null;
  status: "running" | "stopped" | "crashed";
  uptime_seconds: number;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class FleetOSProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "FleetOSProxyError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class FleetOSProxyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail: string | null = null;
        try {
          const errBody = (await res.json()) as { detail?: string; error?: string };
          detail = errBody.detail ?? errBody.error ?? null;
        } catch {
          // ignore
        }
        throw new FleetOSProxyError(
          `FleetOS ${method} ${path} returned ${res.status}`,
          res.status,
          detail,
        );
      }

      // Guard against 204 No Content or empty bodies — res.json() would throw
      if (res.status === 204 || res.headers.get("content-length") === "0") {
        return undefined as unknown as T;
      }
      const text = await res.text();
      if (!text) return undefined as unknown as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof FleetOSProxyError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish timeout from general network errors for callers
      const isTimeout =
        (err instanceof Error && err.name === "AbortError") ||
        /timeout/i.test(message);
      throw new FleetOSProxyError(
        `FleetOS ${method} ${path} failed: ${message}`,
        isTimeout ? 504 : 503,
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Container CRUD
  async listContainers(): Promise<FleetContainer[]> {
    return this.request<FleetContainer[]>("GET", "/api/v1/containers");
  }

  async getContainer(id: string): Promise<FleetContainer> {
    return this.request<FleetContainer>("GET", `/api/v1/containers/${encodeURIComponent(id)}`);
  }

  // Health
  async getHealth(id: string): Promise<FleetHealth> {
    return this.request<FleetHealth>("GET", `/api/v1/containers/${encodeURIComponent(id)}/health`);
  }

  // Agent process status
  async getAgentProcess(id: string): Promise<FleetAgentProcess> {
    return this.request<FleetAgentProcess>("GET", `/api/v1/containers/${encodeURIComponent(id)}/agent`);
  }

  // Lifecycle actions
  async startContainer(id: string): Promise<FleetContainer> {
    return this.request<FleetContainer>("POST", `/api/v1/containers/${encodeURIComponent(id)}/start`);
  }

  async stopContainer(id: string): Promise<FleetContainer> {
    return this.request<FleetContainer>("POST", `/api/v1/containers/${encodeURIComponent(id)}/stop`);
  }

  async restartContainer(id: string): Promise<FleetContainer> {
    return this.request<FleetContainer>("POST", `/api/v1/containers/${encodeURIComponent(id)}/restart`);
  }

  // Templates
  async listTemplates(): Promise<FleetTemplate[]> {
    return this.request<FleetTemplate[]>("GET", "/api/templates");
  }

  async getTemplate(name: string): Promise<FleetTemplateDetail> {
    return this.request<FleetTemplateDetail>("GET", `/api/templates/${encodeURIComponent(name)}`);
  }

  // Provisioning
  async validateProvision(body: ProvisionValidateRequest): Promise<ProvisionValidateResponse> {
    return this.request<ProvisionValidateResponse>("POST", "/api/provision/validate", body);
  }

  async startProvision(body: ProvisionRequest): Promise<ProvisionJob> {
    return this.request<ProvisionJob>("POST", "/api/provision", body);
  }

  async getProvisionJob(jobId: string): Promise<ProvisionJob> {
    return this.request<ProvisionJob>("GET", `/api/provision/${encodeURIComponent(jobId)}`);
  }

  async listProvisionJobs(): Promise<ProvisionJob[]> {
    return this.request<ProvisionJob[]>("GET", "/api/provision");
  }
}

// ---------------------------------------------------------------------------
// Factory — reads FLEETOS_API_URL from env
/**
 * Create a FleetOSProxyClient configured from the FLEETOS_API_URL environment variable.
 *
 * @param apiKey - API key to send in the `X-API-Key` header for all requests
 * @returns A configured `FleetOSProxyClient` using `FLEETOS_API_URL` as the base URL
 * @throws FleetOSProxyError when `FLEETOS_API_URL` is not set (statusCode 500)
 */

export function createFleetOSClient(apiKey: string, baseUrl?: string): FleetOSProxyClient {
  const url = baseUrl ?? process.env.FLEETOS_API_URL;
  if (!url) {
    throw new FleetOSProxyError(
      "FleetOS API URL not configured (pass baseUrl or set FLEETOS_API_URL)",
      500,
      null,
    );
  }
  return new FleetOSProxyClient(url, apiKey);
}
