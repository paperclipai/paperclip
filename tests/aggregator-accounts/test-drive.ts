/** Disposable acceptance server: production routes/database, deterministic upstream providers. */
import express from "../../server/node_modules/express/index.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createDb, startEmbeddedPostgresTestDatabase, companies, companyMemberships, toolApplications, toolConnections, connectionGrants, toolCatalogEntries } from "../../packages/db/src/index.ts";
import { toolAccessRoutes } from "../../server/src/routes/tool-access.js";
import { toolAccessService } from "../../server/src/services/tool-access.js";
import { errorHandler } from "../../server/src/middleware/error-handler.js";

// Keep startup alive while the test helper probes ports with unreferenced sockets.
const startup = setInterval(() => undefined, 1000);
async function startAcceptanceDatabase() {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { return await startEmbeddedPostgresTestDatabase("paperclip-aggregator-browser-"); }
    catch (error) { failure = error; await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
  throw failure;
}
const database = await startAcceptanceDatabase();
fs.writeFileSync("/tmp/paperclip-aggregator-acceptance-db.json", JSON.stringify({ connectionString: database.connectionString }), { mode: 0o600 });
const db = createDb(database.connectionString);
const [company] = await db.insert(companies).values({ name: "Managed accounts test drive", issuePrefix: "AGG" }).returning();
const userId = randomUUID();
await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "admin", status: "active" });
const state = { arcadeAccounts: ["Work", "Personal"], executorAccounts: ["Work"], failed: false, partial: false, unsupported: false };
const gatewayNames = { composio: ["COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_SEARCH_TOOLS"], arcade: ["Notion.ListPages"], executor: ["integrations"], notion: ["notion-read"] };
const connections = [];
for (const provider of ["notion", "composio", "arcade", "executor", "arcade"] as const) {
  const optional = provider === "arcade" && connections.some(connection => connection.provider === "arcade");
  const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: optional ? "arcade optional" : provider, type: "mcp_http", metadata: { sourceTemplateKey: provider } }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, uid: randomUUID(), name: optional ? "Arcade without sync" : provider === "notion" ? "Native workspace" : `Team ${provider[0].toUpperCase()}${provider.slice(1)}`, transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true, createdByUserId: userId,
    config: { sourceTemplateKey: provider, url: provider === "arcade" ? "https://api.arcade.dev/mcp/test" : `https://${provider}.example/mcp`, ...(provider === "executor" ? { managementUrl: "https://executor.sh/test-workspace/integrations" } : {}) } }).returning();
  await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "organization", status: "active", isDefault: true });
  await db.insert(toolCatalogEntries).values(gatewayNames[provider].map(toolName => ({ companyId: company.id, connectionId: connection.id, name: toolName, toolName, versionHash: "v1", status: "active", riskLevel: "read" as const })));
  connections.push({ ...connection, provider, optional });
}
const remoteHttpRequest = async (rawUrl: string, init: RequestInit): Promise<Response> => {
  const url = new URL(rawUrl);
  const rpc = init.body ? JSON.parse(String(init.body)) : undefined;
  const provider = url.hostname.startsWith("api.arcade") ? "arcade" : url.hostname.split(".")[0] as keyof typeof gatewayNames;
  if (rpc?.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: provider, version: "fixture" } } });
  if (rpc?.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (rpc?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: (provider === "executor" && state.unsupported ? ["ping"] : gatewayNames[provider]).map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) } });
  if (state.failed) return new Response("Fixture authorization expired", { status: 401 });
  if (provider === "arcade") {
    if (url.pathname === "/v1/tools") return Response.json({ items: [{ qualified_name: "Notion.ListPages", toolkit: { name: "Notion" }, requirements: { met: true, authorization: { provider_id: "notion", token_status: "completed" } } }] });
    return Response.json({ items: state.arcadeAccounts.map(alias => ({ id: `arcade-${alias}`, user_id: "arcade-user", provider_id: "notion", connection_status: "active", provider_user_info: { email: alias } })), ...(state.partial ? { total: 100 } : {}) });
  }
  if (provider === "composio") {
    const args = rpc.params.arguments;
    if (rpc.params.name === "COMPOSIO_SEARCH_TOOLS") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { results: [] } } });
    const results = Object.fromEntries(args.toolkits.map((toolkit: { name: string }) => [toolkit.name, { toolkit: toolkit.name, accounts: toolkit.name === "notion" ? [{ id: "composio-Work", alias: "Work", status: "active", is_default: true }] : [] }]));
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { data: { results } } } });
  }
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { items: [...state.executorAccounts.map(alias => ({ integration: "notion", integrationName: "Notion", connection: alias, owner: "org", lastHealth: { status: "healthy", checkedAt: Date.now() } })), { integration: "internal-research", integrationName: "Internal research", connection: "Research", owner: "org", lastHealth: null }], hasMore: state.partial, nextOffset: state.partial ? 0 : null } } });
};
const actor = { actorType: "user" as const, actorId: userId };
const svc = toolAccessService(db, { remoteHttpRequest, composioAppToolkits: ["notion"] });
for (const connection of connections) {
  if (connection.provider === "arcade" && !connection.optional) await svc.configureArcadeDiscovery(connection.id, { apiKey: "fixture-discovery-key", userId: "arcade-user" }, actor);
  else if (["composio", "executor"].includes(connection.provider)) await svc.syncAggregatorApps(connection.id, true, actor);
}
const app = express();
app.use((_req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "http://localhost:6200"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type"); next(); });
app.options(/.*/, (_req, res) => { res.sendStatus(204); });
app.use(express.json());
app.get("/fixture", (_req, res) => res.json({ companyId: company.id, connections: connections.map(({ id, name, provider }) => ({ id, name, provider })) }));
app.post("/fixture", (req, res) => { Object.assign(state, req.body); res.json(state); });
app.use((req, _res, next) => { req.actor = { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [company.id], memberships: [{ companyId: company.id, membershipRole: "admin", status: "active" }] }; next(); });
app.use("/api", toolAccessRoutes(db, { remoteHttpRequest }));
app.use(errorHandler);
const server = app.listen(4310, "127.0.0.1", () => { clearInterval(startup); console.log("Managed-account fixture API ready at http://localhost:4310/fixture"); });
async function stop() {
  server.close();
  fs.rmSync("/tmp/paperclip-aggregator-acceptance-db.json", { force: true });
  await database.cleanup();
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
