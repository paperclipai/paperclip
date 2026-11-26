import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { agents, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { type LifecycleAgent } from "../modules/agent-lifecycle/index.js";
import { agentService } from "./agents.js";
import { agentCredentialService } from "./agent-credentials.js";
import { persistActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";

const policySchema = z.object({
  companyId: z.string().uuid(),
  projectId: z.string().uuid(),
  adminUrl: z.string().url(),
  adminTokenFile: z.string().min(1),
  gatewayHost: z.string().url(),
  ports: z.array(z.number().int().min(1024).max(65535)).min(1).max(256),
  paperclipApiUrl: z.string().url(),
  profileConfig: z.record(z.string(), z.unknown()),
});
type Policy = z.infer<typeof policySchema>;
type AgentRow = typeof agents.$inferSelect;

function origin(value: string): URL {
  const url = new URL(value);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error("Hermes lifecycle needs a private HTTPS or IPv4 loopback origin");
  return url;
}

async function loadPolicy(companyId: string): Promise<Policy> {
  const file = process.env.PAPERCLIP_HERMES_PROFILE_POLICY_FILE;
  if (!file) throw new Error("No managed Hermes profile policy is configured");
  const policy = policySchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (policy.companyId !== companyId) throw new Error("Managed Hermes profiles are unavailable for this company");
  origin(policy.adminUrl);
  origin(policy.gatewayHost);
  origin(policy.paperclipApiUrl);
  return policy;
}

class HermesAdmin {
  constructor(private readonly base: URL, private readonly token: string) {}

  async request(path: string, method = "GET", body?: Record<string, unknown>, allowMissing = false): Promise<unknown> {
    const response = await fetch(new URL(path, this.base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
      headers: { "X-Hermes-Session-Token": this.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Hermes management operation failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  async profiles() {
    return z.object({ profiles: z.array(z.object({ name: z.string(), description: z.string() })) })
      .parse(await this.request("/api/profiles")).profiles;
  }

  async status(profile: string) {
    return z.object({ gateway_running: z.boolean(), gateway_state: z.string().nullable() })
      .parse(await this.request(`/api/status?profile=${profile}`));
  }

  async setEnv(profile: string, key: string, value: string) {
    await this.request("/api/env", "PUT", { profile, key, value });
  }
}

function reference(secretId: string) {
  return { type: "secret_ref", secretId, version: "latest" };
}

function profileFor(agent: AgentRow) {
  return `paperclip-${agent.id}`;
}

function markerFor(agent: AgentRow) {
  return `Managed by Paperclip company ${agent.companyId} for agent ${agent.id}`;
}

async function lockedAgent(tx: Db, snapshot: LifecycleAgent): Promise<AgentRow | undefined> {
  const [agent] = await tx.select().from(agents)
    .where(and(eq(agents.companyId, snapshot.companyId), eq(agents.id, snapshot.id))).for("update");
  const operation = agent?.lifecycleOperation;
  if (
    !agent || !operation || !snapshot.lifecycleOperation?.leaseOwner ||
    agent.lifecycleState !== snapshot.lifecycleState || agent.lifecycleVersion !== snapshot.lifecycleVersion ||
    operation.id !== snapshot.lifecycleOperation.id || operation.leaseOwner !== snapshot.lifecycleOperation.leaseOwner ||
    !(Date.parse(operation.leaseUntil ?? "") > Date.now())
  ) return undefined;
  return agent;
}

async function audit(tx: Db, agent: AgentRow, action: string) {
  await persistActivity(tx, {
    companyId: agent.companyId, actorType: "system", actorId: "agent-lifecycle",
    action, entityType: "agent", entityId: agent.id, details: { profile: profileFor(agent) },
  });
}

async function reserveConnection(db: Db, snapshot: LifecycleAgent, policy: Policy): Promise<boolean> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    // All Paperclip processes sharing this database reserve from the same port pool.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${origin(policy.gatewayHost).origin}, 0))`);
    const agent = await lockedAgent(tx, snapshot);
    if (!agent) return false;

    const secrets = secretService(tx);
    const existing = await ownedSecret(tx, agent, "gateway");
    if (existing) {
      const binding = z.object({ type: z.literal("secret_ref"), secretId: z.string() }).parse(agent.adapterConfig.apiKey);
      if (binding.secretId !== existing.id || agent.adapterConfig.expectedProfile !== profileFor(agent)) {
        throw new Error("Managed Hermes binding is inconsistent with its saved credential");
      }
      return true;
    }
    const [project] = await tx.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, policy.projectId), eq(projects.companyId, agent.companyId)));
    if (!project) throw new Error("Managed Hermes reporting project is unavailable");
    const rows = await tx.select({ config: agents.adapterConfig }).from(agents)
      .where(eq(agents.adapterType, "hermes_gateway"));
    const occupied = new Set(rows.map(row => row.config.apiBaseUrl).filter(value => typeof value === "string")
      .map(value => URL.canParse(value) ? new URL(value) : null)
      .filter(url => url?.hostname === origin(policy.gatewayHost).hostname)
      .map(url => Number(url?.port)));
    const port = policy.ports.find(candidate => !occupied.has(candidate));
    if (port === undefined) throw new Error("No managed Hermes gateway port is available");

    const profile = profileFor(agent);
    const endpoint = origin(policy.gatewayHost);
    endpoint.port = String(port);
    endpoint.pathname = `/p/${profile}`;
    const gateway = await secrets.create(agent.companyId, {
      provider: "local_encrypted", name: `${profile}-gateway`, description: markerFor(agent), value: randomBytes(32).toString("hex"),
    });
    const reporting = await agentService(tx).createApiKey(agent.id, `${profile}-reporting`, { kind: "task_bridge", projectId: project.id }, {
      responsibleUserId: agent.lifecycleOperation?.responsibleUserId,
    });
    await secrets.create(agent.companyId, {
      provider: "local_encrypted", name: `${profile}-reporting`, description: markerFor(agent), value: reporting.token,
    });
    const { url: _url, token: _token, ...adapterConfig } = agent.adapterConfig;
    const config = await secrets.normalizeAdapterConfigForPersistence(agent.companyId, {
      ...adapterConfig, apiBaseUrl: endpoint.toString(), apiKey: reference(gateway.id),
      expectedProfile: profile, paperclipApiUrl: policy.paperclipApiUrl,
    }, { adapterType: "hermes_gateway" });
    // This write is part of the operation that holds the lease. Normal agent
    // edits reset verification and would invalidate the worker's own lease.
    await storeBinding(tx, agent, config);
    await audit(tx, agent, "agent.hermes_gateway_bound");
    return true;
  });
}

async function storeBinding(tx: Db, agent: AgentRow, config: Record<string, unknown>) {
  await tx.update(agents).set({ adapterConfig: config, updatedAt: new Date() }).where(eq(agents.id, agent.id));
  await agentCredentialService(tx).syncAgentSecretBindings({ ...agent, adapterConfig: config }, tx, agent.adapterConfig);
}

async function ownedSecret(tx: Db, agent: AgentRow, suffix: string) {
  const secret = await secretService(tx).getByName(agent.companyId, `${profileFor(agent)}-${suffix}`);
  if (secret && secret.description !== markerFor(agent)) throw new Error("Managed Hermes secret ownership conflict");
  return secret;
}

async function prepareProfile(tx: Db, agent: AgentRow, policy: Policy, admin: HermesAdmin) {
  const profile = profileFor(agent);
  const gateway = await ownedSecret(tx, agent, "gateway");
  const reporting = await ownedSecret(tx, agent, "reporting");
  if (!gateway || !reporting) throw new Error("Managed Hermes credentials are missing");
  const secrets = secretService(tx);
  const context = { consumerType: "agent" as const, consumerId: agent.id, actorType: "system" as const, actorId: "agent-lifecycle" };
  const { config } = await secrets.resolveAdapterConfigForRuntime(agent.companyId, {
    apiKey: reference(gateway.id),
  }, context, { adapterType: "hermes_gateway" });
  // The reporting credential has a separate, operator-owned purpose. Resolve
  // only the exact secret identified by this agent's immutable ownership marker.
  const report = await secrets.resolveAdapterConfigForRuntime(agent.companyId, {
    env: { PAPERCLIP_BRIDGE_API_KEY: reference(reporting.id) },
  }, context, { userSecretMediation: "owner_scoped" });
  const key = z.string().min(1).parse(config.apiKey);
  const bridge = z.object({ PAPERCLIP_BRIDGE_API_KEY: z.string().min(1) }).parse(report.config.env).PAPERCLIP_BRIDGE_API_KEY;
  const prior = (await admin.profiles()).find(row => row.name === profile);
  if (prior && prior.description !== markerFor(agent)) throw new Error("Managed Hermes profile ownership conflict");
  if (!prior) {
    await admin.request("/api/profiles", "POST", {
      name: profile, description: markerFor(agent), mirror_credentials: false, share_auth: false, no_skills: true,
    });
  }
  const status = await admin.status(profile);
  if (status.gateway_running && status.gateway_state === "running") return "complete" as const;
  if (status.gateway_running || status.gateway_state === "starting") return "pending" as const;

  const endpoint = new URL(String(agent.adapterConfig.apiBaseUrl));
  await admin.request(`/api/config?profile=${profile}`, "PUT", { config: {
    ...policy.profileConfig,
    gateway: { standalone: true, multiplex_profiles: false },
    platforms: { api_server: { enabled: true, extra: { host: "127.0.0.1", port: Number(endpoint.port) } } },
  } });
  await admin.setEnv(profile, "API_SERVER_KEY", key);
  await admin.setEnv(profile, "PAPERCLIP_BRIDGE_API_KEY", bridge);
  await admin.setEnv(profile, "PAPERCLIP_API_URL", policy.paperclipApiUrl);
  await admin.request(`/api/gateway/start?profile=${profile}`, "POST");
  // The management endpoint acknowledges command spawn, before the gateway
  // writes its first status. Give the supervisor time to observe that start.
  await setTimeout(3_000);
  return "pending" as const;
}

async function retireProfile(tx: Db, agent: AgentRow, admin: HermesAdmin) {
  const profile = profileFor(agent);
  const owned = (await admin.profiles()).find(row => row.name === profile);
  if (owned) {
    if (owned.description !== markerFor(agent)) throw new Error("Managed Hermes profile ownership conflict");
    const status = await admin.status(profile);
    if (status.gateway_running || status.gateway_state === "starting") {
      await admin.request(`/api/gateway/stop?profile=${profile}`, "POST");
      return "pending" as const;
    }
    for (const key of ["API_SERVER_KEY", "PAPERCLIP_BRIDGE_API_KEY"]) {
      await admin.request("/api/env", "DELETE", { profile, key }, true);
    }
  }
  const secrets = secretService(tx);
  const gateway = await ownedSecret(tx, agent, "gateway");
  const reporting = await ownedSecret(tx, agent, "reporting");
  if (gateway) await secrets.remove(gateway.id);
  if (reporting) await secrets.remove(reporting.id);
  const { apiBaseUrl: _base, apiKey: _key, expectedProfile: _profile, ...config } = agent.adapterConfig;
  await storeBinding(tx, agent, config);
  await audit(tx, agent, "agent.hermes_gateway_retired");
  return "complete" as const;
}

export async function reconcileManagedHermesGateway(db: Db, snapshot: LifecycleAgent) {
  if (!["preparing", "cleaning_up"].includes(snapshot.lifecycleState)) return "complete" as const;
  const [row] = await db.select({ type: agents.adapterType, config: agents.adapterConfig }).from(agents)
    .where(and(eq(agents.companyId, snapshot.companyId), eq(agents.id, snapshot.id)));
  if (row?.type !== "hermes_gateway" || row.config.managedProfile !== true) return "complete" as const;
  const policy = await loadPolicy(snapshot.companyId);
  if (snapshot.lifecycleState === "preparing" && !await reserveConnection(db, snapshot, policy)) return "pending" as const;

  const token = (await readFile(policy.adminTokenFile, "utf8")).trim();
  if (!token) throw new Error("Hermes management credential is missing");
  const admin = new HermesAdmin(origin(policy.adminUrl), token);
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    // Serialize changes for this agent across lifecycle phases. A stop cannot
    // overtake an in-flight prepare request from the previous lease.
    const agent = await lockedAgent(tx, snapshot);
    if (!agent) return "pending" as const;
    return snapshot.lifecycleState === "preparing"
      ? prepareProfile(tx, agent, policy, admin)
      : retireProfile(tx, agent, admin);
  });
}
