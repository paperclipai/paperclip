import { createHash } from "node:crypto";
import { DaytonaNotFoundError, type CreateSandboxFromImageParams, type CreateSandboxFromSnapshotParams, type Daytona, type Sandbox } from "@daytonaio/sdk";
import { SERVICE_RETENTION_LABEL } from "./service-runtime.js";
import { assertDaytonaServiceDataAvailable } from "./service-data-deletion.js";

type CreateParams = CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams;
export const SERVICE_ALLOCATION_LABEL = "paperclip-service-allocation-id";
const CONFIG_LABEL = "paperclip-service-allocation-config";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** The database claim must exist before this call; the provider name recovers a lost receipt. */
export async function acquireDaytonaServiceAllocation(input: {
  client: Pick<Daytona, "get" | "create">;
  allocationId: string;
  companyId: string;
  environmentId: string;
  params: CreateParams;
  target?: string | null;
  timeoutSeconds: number;
  /** Check mutable snapshot configuration only before a fresh create. Existing
   * allocations must remain recoverable if their original snapshot is gone. */
  beforeCreate?: () => Promise<void>;
}): Promise<Sandbox> {
  if (![input.allocationId, input.companyId, input.environmentId].every((id) => uuid.test(id))) throw new Error("Invalid service allocation identity");
  const name = `paperclip-service-${input.allocationId}`;
  // Lifecycle belongs to Paperclip from the moment the sandbox exists, including
  // a lost create response before the host can configure retention again.
  const params = { ...input.params, name, public: false, ephemeral: false,
    autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1, ttlMinutes: 0 };
  const { labels: _labels, ...shape } = params;
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical({ shape, target: input.target ?? null }))).digest("hex");
  const labels = {
    "paperclip-provider": "daytona", "paperclip-company-id": input.companyId,
    "paperclip-environment-id": input.environmentId, "paperclip-purpose": "runtime_service",
    [SERVICE_ALLOCATION_LABEL]: input.allocationId, [CONFIG_LABEL]: fingerprint, [SERVICE_RETENTION_LABEL]: "true",
  };
  async function lookup() {
    try { return await input.client.get(name); }
    catch (error) { if (error instanceof DaytonaNotFoundError) return null; throw error; }
  }
  async function verified(sandbox: Sandbox) {
    await sandbox.refreshData();
    assertDaytonaServiceDataAvailable(sandbox);
    if (sandbox.name !== name || Object.entries(labels).some(([key, value]) => sandbox.labels[key] !== value)) {
      throw new Error("Service allocation ownership or configuration does not match its recorded identity");
    }
    return sandbox;
  }
  const existing = await lookup();
  if (existing) return verified(existing);
  await input.beforeCreate?.();
  try {
    return await verified(await input.client.create({ ...params, labels }, { timeout: input.timeoutSeconds }));
  } catch (createError) {
    // This includes a competing controller winning the unique-name create and
    // the SDK timing out while waiting for an already-created sandbox to start.
    // Failed lookups never authorize a new identity or destructive cleanup.
    const recovered = await lookup().catch(() => null);
    if (recovered) return verified(recovered);
    throw createError;
  }
}
