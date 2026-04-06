import type { Db } from "@paperclipai/db";
import { sandboxEnvironments, agents as agentsTable } from "@paperclipai/db";
import { and, eq, desc } from "drizzle-orm";

export function sandboxService(db: Db) {
  return {
    async list(companyId: string, agentId?: string) {
      const conditions = [eq(sandboxEnvironments.companyId, companyId)];
      if (agentId) conditions.push(eq(sandboxEnvironments.agentId, agentId));
      return db
        .select()
        .from(sandboxEnvironments)
        .where(and(...conditions))
        .orderBy(desc(sandboxEnvironments.createdAt));
    },

    async get(companyId: string, id: string) {
      const [row] = await db
        .select()
        .from(sandboxEnvironments)
        .where(and(eq(sandboxEnvironments.id, id), eq(sandboxEnvironments.companyId, companyId)));
      return row ?? null;
    },

    async create(companyId: string, input: {
      agentId?: string;
      provider?: string;
      region?: string;
      template?: string;
      timeoutSeconds?: number;
      cpuMillicores?: number;
      memoryMb?: number;
      diskMb?: number;
      ports?: number[];
      envVars?: Record<string, string>;
    }) {
      const [row] = await db
        .insert(sandboxEnvironments)
        .values({
          companyId,
          agentId: input.agentId,
          provider: input.provider ?? "e2b",
          region: input.region ?? "us-east-1",
          template: input.template,
          timeoutSeconds: input.timeoutSeconds ?? 300,
          cpuMillicores: input.cpuMillicores ?? 1000,
          memoryMb: input.memoryMb ?? 512,
          diskMb: input.diskMb ?? 1024,
          ports: input.ports ?? [],
          envVars: input.envVars ?? {},
          status: "pending",
        })
        .returning();
      return row;
    },

    async start(companyId: string, id: string) {
      const sandbox = await this.get(companyId, id);
      if (!sandbox) return null;
      if (sandbox.status === "running") return sandbox;

      const provisionResult = await provisionSandbox(sandbox);

      const [updated] = await db
        .update(sandboxEnvironments)
        .set({
          status: provisionResult.success ? "running" : "error",
          sandboxId: provisionResult.sandboxId ?? sandbox.sandboxId,
          sandboxUrl: provisionResult.sandboxUrl,
          terminalUrl: provisionResult.terminalUrl,
          logsUrl: provisionResult.logsUrl,
          startedAt: new Date(),
          errorMessage: provisionResult.error,
          updatedAt: new Date(),
        })
        .where(and(eq(sandboxEnvironments.id, id), eq(sandboxEnvironments.companyId, companyId)))
        .returning();
      return updated;
    },

    async stop(companyId: string, id: string) {
      const sandbox = await this.get(companyId, id);
      if (!sandbox) return null;

      if (sandbox.sandboxId && sandbox.status === "running") {
        await teardownSandbox(sandbox);
      }

      const [updated] = await db
        .update(sandboxEnvironments)
        .set({
          status: "stopped",
          stoppedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(sandboxEnvironments.id, id), eq(sandboxEnvironments.companyId, companyId)))
        .returning();
      return updated;
    },

    async remove(companyId: string, id: string) {
      const sandbox = await this.get(companyId, id);
      if (!sandbox) return false;
      if (sandbox.status === "running") {
        await teardownSandbox(sandbox);
      }
      await db
        .delete(sandboxEnvironments)
        .where(and(eq(sandboxEnvironments.id, id), eq(sandboxEnvironments.companyId, companyId)));
      return true;
    },

    async updateAgentSandboxConfig(companyId: string, agentId: string, config: {
      sandboxEnabled?: boolean;
      sandboxProvider?: string;
      sandboxTemplate?: string;
      sandboxTimeoutSeconds?: number;
      sandboxAutoStart?: boolean;
    }) {
      const [updated] = await db
        .update(agentsTable)
        .set({
          ...config,
          updatedAt: new Date(),
        })
        .where(and(eq(agentsTable.id, agentId), eq(agentsTable.companyId, companyId)))
        .returning();
      return updated ?? null;
    },
  };
}

interface ProvisionResult {
  success: boolean;
  sandboxId?: string;
  sandboxUrl?: string;
  terminalUrl?: string;
  logsUrl?: string;
  error?: string;
}

// Real sandbox provisioning - calls external APIs
async function provisionSandbox(sandbox: typeof sandboxEnvironments.$inferSelect): Promise<ProvisionResult> {
  const provider = sandbox.provider;

  if (provider === "e2b") {
    return provisionE2BSandbox(sandbox);
  } else if (provider === "docker") {
    return provisionDockerSandbox(sandbox);
  }

  return { success: false, error: `Unknown sandbox provider: ${provider}` };
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  delayMs = 1000,
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      // Retry on 5xx server errors, not on 4xx client errors
      if (response.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw new Error("fetchWithRetry: all attempts exhausted");
}

async function provisionE2BSandbox(sandbox: typeof sandboxEnvironments.$inferSelect): Promise<ProvisionResult> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    return { success: false, error: "E2B_API_KEY environment variable is not set. Configure it to use E2B sandboxes." };
  }

  try {
    const response = await fetchWithRetry("https://api.e2b.dev/sandboxes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        templateID: sandbox.template || "base",
        timeout: sandbox.timeoutSeconds ?? 300,
        metadata: {
          companyId: sandbox.companyId,
          agentId: sandbox.agentId ?? "",
          sandboxDbId: sandbox.id,
        },
        ...(sandbox.cpuMillicores && sandbox.cpuMillicores !== 1000 ? { cpuCount: Math.max(1, Math.round(sandbox.cpuMillicores / 1000)) } : {}),
        ...(sandbox.memoryMb && sandbox.memoryMb !== 512 ? { memoryMB: sandbox.memoryMb } : {}),
        ...(sandbox.envVars && Object.keys(sandbox.envVars).length > 0 ? { envVars: sandbox.envVars } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `E2B API error (${response.status}): ${errorText}` };
    }

    const data = await response.json() as { sandboxID: string; clientID: string };
    const sandboxId = data.sandboxID;

    // Verify sandbox is running with a health check
    try {
      const healthRes = await fetchWithRetry(`https://api.e2b.dev/sandboxes/${sandboxId}`, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
      }, 2, 2000);
      if (!healthRes.ok) {
        return { success: false, sandboxId, error: `E2B sandbox created but health check failed (${healthRes.status})` };
      }
    } catch {
      // Non-fatal: sandbox was created, health check is best-effort
    }

    return {
      success: true,
      sandboxId,
      sandboxUrl: `https://${sandboxId}.e2b.dev`,
      terminalUrl: `https://${sandboxId}.e2b.dev/terminal`,
      logsUrl: `https://e2b.dev/dashboard/sandboxes/${sandboxId}`,
    };
  } catch (err) {
    return { success: false, error: `E2B connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function provisionDockerSandbox(sandbox: typeof sandboxEnvironments.$inferSelect): Promise<ProvisionResult> {
  const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
  const apiBase = dockerHost.startsWith("unix://")
    ? "http://localhost"
    : dockerHost.replace(/^tcp:\/\//, "http://");
  const apiVersion = "v1.43";

  try {
    const image = sandbox.template || "ubuntu:22.04";

    // Pull the image first (best-effort, may already be cached)
    try {
      await fetchWithRetry(`${apiBase}/${apiVersion}/images/create?fromImage=${encodeURIComponent(image)}`, {
        method: "POST",
      }, 2, 3000);
    } catch {
      // Image pull failed — may already exist locally, proceed with create
    }

    // Build port bindings if ports are specified
    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const port of sandbox.ports ?? []) {
      const key = `${port}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: "0" }]; // auto-assign host port
    }

    const response = await fetchWithRetry(`${apiBase}/${apiVersion}/containers/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Image: image,
        Cmd: ["/bin/bash"],
        Tty: true,
        OpenStdin: true,
        ExposedPorts: Object.keys(exposedPorts).length > 0 ? exposedPorts : undefined,
        HostConfig: {
          Memory: (sandbox.memoryMb ?? 512) * 1024 * 1024,
          NanoCpus: (sandbox.cpuMillicores ?? 1000) * 1_000_000,
          DiskQuota: sandbox.diskMb ? sandbox.diskMb * 1024 * 1024 : undefined,
          PortBindings: Object.keys(portBindings).length > 0 ? portBindings : undefined,
          RestartPolicy: { Name: "unless-stopped" },
        },
        Env: Object.entries(sandbox.envVars ?? {}).map(([k, v]) => `${k}=${v}`),
        Labels: {
          "paperclip.company_id": sandbox.companyId,
          "paperclip.agent_id": sandbox.agentId ?? "",
          "paperclip.sandbox_id": sandbox.id,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Docker API error (${response.status}): ${errorText}` };
    }

    const data = await response.json() as { Id: string; Warnings?: string[] };
    const containerId = data.Id;

    // Start the container with retry
    const startRes = await fetchWithRetry(`${apiBase}/${apiVersion}/containers/${containerId}/start`, {
      method: "POST",
    }, 2, 1000);

    if (!startRes.ok && startRes.status !== 304) { // 304 = already started
      // Cleanup the created container
      try { await fetch(`${apiBase}/${apiVersion}/containers/${containerId}?force=true`, { method: "DELETE" }); } catch { /* best-effort */ }
      return { success: false, sandboxId: containerId, error: `Docker container start failed: ${startRes.status}` };
    }

    // Health check: verify container is running
    try {
      const inspectRes = await fetchWithRetry(`${apiBase}/${apiVersion}/containers/${containerId}/json`, {
        method: "GET",
      }, 3, 1000);

      if (inspectRes.ok) {
        const inspect = await inspectRes.json() as { State?: { Running?: boolean; Status?: string } };
        if (!inspect.State?.Running) {
          return {
            success: false,
            sandboxId: containerId,
            error: `Docker container created but not running (status: ${inspect.State?.Status ?? "unknown"})`,
          };
        }
      }
    } catch {
      // Non-fatal: container was started, inspect is best-effort
    }

    const shortId = containerId.slice(0, 12);
    return {
      success: true,
      sandboxId: containerId,
      sandboxUrl: `${apiBase}/containers/${shortId}`,
      terminalUrl: `${apiBase}/containers/${shortId}/exec`,
      logsUrl: `${apiBase}/${apiVersion}/containers/${shortId}/logs?stdout=true&stderr=true&follow=true`,
    };
  } catch (err) {
    return { success: false, error: `Docker connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function teardownSandbox(sandbox: typeof sandboxEnvironments.$inferSelect): Promise<void> {
  if (!sandbox.sandboxId) return;

  if (sandbox.provider === "e2b") {
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) return;
    try {
      await fetch(`https://api.e2b.dev/sandboxes/${sandbox.sandboxId}`, {
        method: "DELETE",
        headers: { "X-API-Key": apiKey },
      });
    } catch {
      // Best-effort cleanup
    }
  } else if (sandbox.provider === "docker") {
    const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
    const apiBase = dockerHost.startsWith("unix://")
      ? "http://localhost"
      : dockerHost.replace(/^tcp:\/\//, "http://");
    try {
      await fetch(`${apiBase}/v1.43/containers/${sandbox.sandboxId}?force=true`, { method: "DELETE" });
    } catch {
      // Best-effort cleanup
    }
  }
}
