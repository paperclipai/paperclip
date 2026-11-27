import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, ne, sql } from "drizzle-orm";
import { agents, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { type LifecycleAgent } from "../modules/agent-lifecycle/index.js";
import { agentService } from "./agents.js";
import { agentCredentialService } from "./agent-credentials.js";
import { persistActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";

import { assertManagedHermesReportingLine, loadManagedHermesPolicy, origin, type Policy } from "./hermes-gateway-policy.js";

type AgentRow = typeof agents.$inferSelect;

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

  async settle(profile: string, desired: "running" | "retired") {
    const result = z.object({ profile: z.literal(profile), desired: z.literal(desired), settled: z.boolean() })
      .parse(await this.request(`/api/gateway/lifecycle?profile=${profile}&desired=${desired}`, "PUT"));
    return result.settled;
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

async function reserveConnection(
  db: Db, snapshot: LifecycleAgent, { policy, digest }: Awaited<ReturnType<typeof loadManagedHermesPolicy>>,
): Promise<boolean> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${origin(policy.gatewayHost).origin}, 0))`);
    const agent = await lockedAgent(tx, snapshot);
    if (!agent) return false;
    const { managedProfileAuthorizedBy: requester, managedProfilePolicyDigest } = agent.adapterConfig;
    if (typeof requester !== "string") {
      throw new Error("Managed Hermes profile has no hire authorization");
    }
    if (managedProfilePolicyDigest !== undefined) {
      if (!policy.allowReportingLineHires || managedProfilePolicyDigest !== digest) {
        throw new Error("The approved managed Hermes configuration changed before provisioning");
      }
      await assertManagedHermesReportingLine(tx, agent.companyId, requester, agent.reportsTo);
    }

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
      .where(and(eq(agents.adapterType, "hermes_gateway"), ne(agents.lifecycleState, "terminated")));
    const occupied = new Set(rows.map(row => row.config.apiBaseUrl).filter(value => typeof value === "string")
      .map(value => URL.canParse(value) ? new URL(value) : null)
      .filter(url => url?.hostname === origin(policy.gatewayHost).hostname)
      .map(url => Number(url?.port)));
    const slot = policy.slots.find(candidate => !occupied.has(candidate.port));
    if (!slot) throw new Error("No managed Hermes gateway port is available");

    const profile = profileFor(agent);
    const endpoint = origin(policy.gatewayHost);
    endpoint.port = String(slot.port);
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
      managedProfileAdminOrigin: origin(slot.adminUrl).origin,
    }, { adapterType: "hermes_gateway" });
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
  if (!status.gateway_running && status.gateway_state !== "starting") {
    const endpoint = new URL(String(agent.adapterConfig.apiBaseUrl));
    await admin.request(`/api/config?profile=${profile}`, "PUT", { config: {
      ...policy.profileConfig,
      gateway: { standalone: true, multiplex_profiles: false },
      platforms: { api_server: { enabled: true, extra: { host: "127.0.0.1", port: Number(endpoint.port) } } },
    } });
    await admin.setEnv(profile, "API_SERVER_KEY", key);
    await admin.setEnv(profile, "PAPERCLIP_BRIDGE_API_KEY", bridge);
    await admin.setEnv(profile, "PAPERCLIP_API_URL", policy.paperclipApiUrl);
  }
  if (!await admin.settle(profile, "running")) return "pending" as const;
  const afterStart = await admin.status(profile);
  return afterStart.gateway_running && afterStart.gateway_state === "running"
    ? "complete" as const : "pending" as const;
}

async function retireProfile(tx: Db, agent: AgentRow, admin: HermesAdmin | null) {
  const profile = profileFor(agent);
  const owned = admin && (await admin.profiles()).find(row => row.name === profile);
  if (admin && owned) {
    if (owned.description !== markerFor(agent)) throw new Error("Managed Hermes profile ownership conflict");
    if (!await admin.settle(profile, "retired")) return "pending" as const;
    for (const key of ["API_SERVER_KEY", "PAPERCLIP_BRIDGE_API_KEY"]) {
      await admin.request("/api/env", "DELETE", { profile, key }, true);
    }
  }
  const secrets = secretService(tx);
  const gateway = await ownedSecret(tx, agent, "gateway");
  const reporting = await ownedSecret(tx, agent, "reporting");
  if (gateway) await secrets.remove(gateway.id);
  if (reporting) await secrets.remove(reporting.id);
  const { apiBaseUrl: _base, apiKey: _key, expectedProfile: _profile, managedProfileAdminOrigin: _origin, ...config } = agent.adapterConfig;
  await storeBinding(tx, agent, config);
  await audit(tx, agent, "agent.hermes_gateway_retired");
  return "complete" as const;
}

async function adminForBinding(agent: AgentRow, policy: Policy): Promise<HermesAdmin | null> {
  const { apiBaseUrl, managedProfileAdminOrigin } = agent.adapterConfig;
  if (apiBaseUrl === undefined) return null;
  const endpoint = new URL(z.string().parse(apiBaseUrl));
  const gatewayHost = origin(policy.gatewayHost);
  const slot = policy.slots.find(candidate => candidate.port === Number(endpoint.port));
  if (!slot || endpoint.hostname !== gatewayHost.hostname || endpoint.protocol !== gatewayHost.protocol ||
      endpoint.pathname !== `/p/${profileFor(agent)}`) {
    throw new Error("Managed Hermes binding does not match an admitted slot");
  }
  const base = origin(slot.adminUrl);
  if (managedProfileAdminOrigin !== base.origin &&
      (managedProfileAdminOrigin !== undefined || policy.slots.length !== 1)) {
    throw new Error("Managed Hermes Dashboard changed after this slot was reserved");
  }
  const token = (await readFile(slot.adminTokenFile, "utf8")).trim();
  if (!token) throw new Error("Hermes management credential is missing");
  return new HermesAdmin(base, token);
}

export async function reconcileManagedHermesGateway(db: Db, snapshot: LifecycleAgent) {
  if (!["preparing", "cleaning_up"].includes(snapshot.lifecycleState)) return "complete" as const;
  const [row] = await db.select({ type: agents.adapterType, config: agents.adapterConfig }).from(agents)
    .where(and(eq(agents.companyId, snapshot.companyId), eq(agents.id, snapshot.id)));
  if (row?.type !== "hermes_gateway" || row.config.managedProfile !== true) return "complete" as const;
  const binding = await loadManagedHermesPolicy(snapshot.companyId);
  if (snapshot.lifecycleState === "preparing" && !await reserveConnection(db, snapshot, binding)) return "pending" as const;
  const { policy } = binding;

  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const agent = await lockedAgent(tx, snapshot);
    if (!agent) return "pending" as const;
    const admin = await adminForBinding(agent, policy);
    if (snapshot.lifecycleState !== "preparing") return retireProfile(tx, agent, admin);
    if (!admin) throw new Error("Managed Hermes profile has no reserved slot");
    return prepareProfile(tx, agent, policy, admin);
  });
}
