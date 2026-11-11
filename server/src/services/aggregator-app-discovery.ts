import type { ComposioAppAccount } from "@paperclipai/shared";
import { aggregatorManagementUrl } from "@paperclipai/shared/aggregator-apps";
import { resolveAggregatorApp } from "@paperclipai/shared/aggregator-app-catalog";

export class AggregatorDiscoveryUnavailableError extends Error {}

export type DiscoveredApp = { toolkit: string; accounts: ComposioAppAccount[] };
export type JsonRequest = (path: string) => Promise<unknown>;
export type McpCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Read only explicit structured/JSON result channels, never provider prose. */
export function inventoryPayload(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8) throw new Error("Malformed provider inventory");
  const root = record(value);
  if (root.error || root.isError) throw new Error("Provider account discovery failed");
  if (root.result !== undefined) return inventoryPayload(root.result, depth + 1);
  if (root.structuredContent !== undefined) return inventoryPayload(root.structuredContent, depth + 1);
  if (root.value !== undefined && !root.items && !root.connections) return inventoryPayload(root.value, depth + 1);
  if (Array.isArray(root.content)) {
    for (const block of root.content) {
      if (record(block).type !== "text") continue;
      try { return inventoryPayload(JSON.parse(String(record(block).text)), depth + 1); } catch { /* Try another JSON block. */ }
    }
    throw new Error("Provider did not return an account inventory");
  }
  return root;
}

async function pages(request: JsonRequest, path: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = record(await request(`${path}${path.includes("?") ? "&" : "?"}limit=100&offset=${offset}`));
    if (!Array.isArray(page.items) || page.items.some(item => !item || typeof item !== "object")) throw new Error("Incomplete provider inventory");
    result.push(...page.items.map(record));
    const total = typeof page.total_count === "number" ? page.total_count : typeof page.total === "number" ? page.total : undefined;
    if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) throw new Error("Incomplete provider inventory");
    if (total !== undefined && result.length >= total) return result;
    // Arcade returns the next offset, which can advance after a short page.
    if (page.offset !== undefined) {
      if (page.offset === 0 && total === undefined) return result;
      if (!page.items.length || !Number.isSafeInteger(page.offset) || Number(page.offset) <= offset) throw new Error("Incomplete provider inventory");
      offset = Number(page.offset);
    } else {
      if (page.items.length < 100) {
        if (total !== undefined) throw new Error("Incomplete provider inventory");
        return result;
      }
      offset += 100;
    }
  }
  throw new Error("Provider inventory exceeded the discovery limit");
}

export async function discoverArcadeApps(input: { request: JsonRequest; userId: string; gatewayTools: string[] }): Promise<DiscoveredApp[]> {
  const [accounts, tools] = await Promise.all([
    pages(input.request, `/v1/admin/user_connections?user[id]=${encodeURIComponent(input.userId)}`),
    pages(input.request, `/v1/tools?user_id=${encodeURIComponent(input.userId)}`),
  ]);
  const exposed = new Set(input.gatewayTools);
  const grouped = new Map<string, Map<string, ComposioAppAccount>>();
  for (const tool of tools) {
    const toolName = string(tool.qualified_name) ?? string(tool.name);
    const names = [toolName, string(tool.fully_qualified_name), string(tool.name)].filter((name): name is string => Boolean(name));
    if (!toolName || !names.some(name => exposed.has(name) || exposed.has(name.replaceAll(".", "_")))) continue;
    const toolkit = string(record(tool.toolkit).name) ?? toolName.split(/[._]/)[0];
    const requirements = record(tool.requirements);
    const auth = record(requirements.authorization);
    const providerId = string(auth.provider_id);
    if (!providerId || !toolkit) continue;
    const app = resolveAggregatorApp("arcade", toolkit);
    for (const account of accounts) {
      // Admin credentials can enumerate other users; reject unscoped records.
      if (account.user_id !== input.userId || account.provider_id !== providerId) continue;
      const id = string(account.id) ?? string(account.connection_id);
      if (!id) throw new Error("Malformed Arcade account");
      const live = ["active", "connected"].includes(String(account.connection_status).toLowerCase());
      const status = live && requirements.met === true && auth.token_status === "completed" ? "ACTIVE"
        : auth.token_status === "pending" ? "INITIATED" : auth.token_status === "failed" ? "EXPIRED" : "UNVERIFIED";
      const info = record(account.provider_user_info);
      const existing = grouped.get(toolkit) ?? new Map<string, ComposioAppAccount>();
      if (existing.get(id)?.status !== "ACTIVE") existing.set(id, {
        id, alias: string(info.email) ?? string(info.name) ?? null, status, isDefault: false,
        appSlug: app.slug, appName: app.name, managementUrl: aggregatorManagementUrl("arcade"),
      });
      grouped.set(toolkit, existing);
    }
  }
  return [...grouped].map(([toolkit, accounts]) => ({ toolkit, accounts: [...accounts.values()] }));
}

export const EXECUTOR_INVENTORY_CODE = "if (typeof tools === 'undefined' || typeof tools.executor?.coreTools?.connections?.list !== 'function' || typeof tools.executor?.coreTools?.integrations?.list !== 'function') return { discoveryUnavailable: true }; const connections = await tools.executor.coreTools.connections.list({}); const integrations = await tools.executor.coreTools.integrations.list({}); const managementUrls = {}; for (const integration of new Set(connections.connections.map(account => account.integration))) { try { const handoff = await tools.executor.coreTools.connections.createHandoff({ integration }); managementUrls[integration] = handoff.url; } catch {} } return { connections: connections.connections, integrations: integrations.integrations, managementUrls };";

export async function discoverExecutorApps(input: { call: McpCall; toolNames: string[]; managementUrl?: string | null }): Promise<DiscoveredApp[]> {
  const accounts: Record<string, unknown>[] = [];
  const metadata = new Map<string, Record<string, unknown>>();
  let managementUrls: Record<string, unknown> = {};
  if (input.toolNames.includes("integrations")) {
    let offset = 0;
    for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
      const page = inventoryPayload(await input.call("integrations", { limit: 50, offset }));
      if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") throw new Error("Incomplete Executor inventory");
      accounts.push(...page.items.map(record));
      if (!page.hasMore) break;
      if (typeof page.nextOffset !== "number" || page.nextOffset <= offset || pageIndex === 199) throw new Error("Incomplete Executor inventory");
      offset = page.nextOffset;
    }
  } else if (input.toolNames.includes("execute")) {
    const payload = inventoryPayload(await input.call("execute", { code: EXECUTOR_INVENTORY_CODE }));
    if (!Array.isArray(payload.connections) || !Array.isArray(payload.integrations)) throw new AggregatorDiscoveryUnavailableError("Executor account discovery is unavailable on this server");
    accounts.push(...payload.connections.map(record));
    managementUrls = record(payload.managementUrls);
    for (const item of payload.integrations) { const row = record(item); if (string(row.slug)) metadata.set(String(row.slug), row); }
  } else throw new AggregatorDiscoveryUnavailableError("Executor account discovery is unavailable on this server");
  const grouped = new Map<string, ComposioAppAccount[]>();
  for (const account of accounts) {
    const toolkit = string(account.integration);
    const name = string(account.connection) ?? string(account.name);
    const owner = string(account.owner);
    if (!toolkit || !name || !owner) throw new Error("Malformed Executor account");
    const app = resolveAggregatorApp("executor", toolkit, string(account.integrationName) ?? string(metadata.get(toolkit)?.name));
    const health = record(account.lastHealth);
    const status = health.status === "healthy" || health.status === "ok" ? "ACTIVE"
      : health.status === "unhealthy" || health.status === "expired" || health.status === "dead" ? "EXPIRED" : "UNVERIFIED";
    let managementUrl = aggregatorManagementUrl("executor", input.managementUrl);
    if (!managementUrl && typeof managementUrls[toolkit] === "string") {
      managementUrl = aggregatorManagementUrl("executor", managementUrls[toolkit] as string);
      if (managementUrl) { const url = new URL(managementUrl); url.search = ""; url.hash = ""; managementUrl = url.toString(); }
    }
    const id = JSON.stringify([toolkit, owner, name]);
    const before = grouped.get(toolkit) ?? [];
    if (before.some(item => item.id === id)) throw new Error("Duplicate Executor account identity");
    before.push({ id, alias: string(account.identityLabel) ?? name, status, isDefault: false,
      appSlug: app.slug, appName: app.name, healthCheckedAt: typeof health.checkedAt === "number" && Number.isFinite(health.checkedAt) && Math.abs(health.checkedAt) <= 8.64e15 ? new Date(health.checkedAt).toISOString() : string(health.checkedAt) ?? null,
      managementUrl,
    });
    grouped.set(toolkit, before);
  }
  return [...grouped].map(([toolkit, accounts]) => ({ toolkit, accounts }));
}
