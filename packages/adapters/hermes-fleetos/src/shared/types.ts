// ---------------------------------------------------------------------------
// FleetOS API response types
// ---------------------------------------------------------------------------

/** Represents an LXD container managed by FleetOS. */
export interface FleetOSContainer {
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

/** Health telemetry for a FleetOS container. */
export interface FleetOSHealth {
  container_id: string;
  cpu_percent: number;
  mem_percent: number;
  disk_percent: number;
  agent_status: "idle" | "busy" | "error" | "offline";
  uptime_seconds: number;
  last_heartbeat: string;
}

/** Result of executing a command inside a FleetOS container. */
export interface FleetOSExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

/** A provisioning job for creating/configuring a new container. */
export interface FleetOSProvisionJob {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  container_id: string | null;
  steps: FleetOSProvisionStep[];
  result: FleetOSProvisionResult | null;
  created_at: string;
  updated_at: string;
}

export interface FleetOSProvisionStep {
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  detail: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface FleetOSProvisionResult {
  container_id: string;
  ip_address: string;
  error: string | null;
}

/** Standard API error envelope from FleetOS. */
export interface FleetOSApiError {
  error: string;
  detail: string | null;
  status_code: number;
}

/** File read result from the FleetOS files API. */
export interface FleetOSFileContent {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  size_bytes: number;
}

/** Provision spec for requesting a new container. */
export interface FleetOSProvisionSpec {
  name: string;
  image: string;
  tenant_id: string;
  config?: Record<string, unknown>;
  labels?: Record<string, string>;
}
