import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runnerApiCatalog, searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

it.each([
  ["connect my assistant mcp setup", "GET /api/mcp/setup"],
  ["assistant connection consent approve access", "POST /api/mcp/requests/{id}/consent"],
])("search %j says only the person connects an assistant, and links the page", (query, operationId) => {
  const operation = searchRunnerApi({ query, limit: 10 }).results.find(row => row.operationId === operationId);
  expect(operation, query).toBeDefined();
  expect(operation!.description).toContain("[Assistant connections](/<prefix>/apps/assistant-connection)");
  expect(operation!.description).toContain("a read-only member can grant read access but not writes");
  expect(operation!.description).toContain("Do not search for another route");
});

it.each([
  ["tool connection catalog quarantined", "GET /api/tool-connections/{connectionId}/catalog"],
  ["quarantined catalog entry counts review", "GET /api/tool-connections/{connectionId}/review-counts"],
  ["tool apps needing attention", "GET /api/companies/{companyId}/tools/apps/attention"],
])("search %j says where a person reviews a quarantined action", (query, operationId) => {
  const operation = searchRunnerApi({ query, limit: 10 }).results.find(row => row.operationId === operationId);
  expect(operation, query).toBeDefined();
  expect(operation!.description).toContain("[Permissions](/<prefix>/apps/<connectionId>/permissions)");
  expect(operation!.description).toContain("No agent can call a quarantined action");
});

it("says chat endpoint creation needs the experiment, and links where it is turned on", () => {
  const create = searchRunnerApi({ query: "create chat endpoint imessage", limit: 10 }).results.find(row => row.operationId === "POST /api/companies/{companyId}/chat-endpoints");
  expect(create?.description).toContain("[Experimental settings](/<prefix>/company/settings/instance/experimental)");
});

it.each([
  "complete connection request for someone else",
  "connection intent resolve decline",
])("search %j says only the addressee can resolve a connection request card", (query) => {
  const found = searchRunnerApi({ query, limit: 10 }).results.filter(row => row.path.startsWith("/api/connection-intents/"));
  expect(found.length, query).toBeGreaterThan(0);
  for (const operation of found) {
    expect(operation.description).toContain("Only that person, signed in to their own browser");
    expect(operation.description).toContain("[<identifier>](/<prefix>/issues/<identifier>)");
  }
});

it("says on the interaction listing that only the addressee resolves a connection request card", () => {
  const list = searchRunnerApi({ query: "GET /api/issues/{id}/interactions" }).results.find(row => row.operationId === "GET /api/issues/{id}/interactions");
  expect(list?.description).toContain("Only that person can connect or decline it");
});

it("names only pages that the board UI mounts", () => {
  const appRoutes = readFileSync(path.join(repoRoot, "ui/src/App.tsx"), "utf8");
  const pages = new Set(
    runnerApiCatalog()
      .filter(row => /^\/api\/(mcp\/(setup|requests\/\{id\}\/consent)$|connection-intents\/|tool-connections\/\{connectionId\}\/(catalog|review-counts)$|companies\/\{companyId\}\/(tools\/apps\/attention|tools\/apps\/connect|tools\/connections|chat-endpoints)$)/.test(row.path))
      .flatMap(row => [...(row.description ?? "").matchAll(/\/<prefix>\/([a-z0-9/<>-]+)/gi)].map(match => match[1]!)),
  );
  expect([...pages].sort()).toEqual(["apps/<connectionId>/permissions", "apps/assistant-connection", "apps/byo", "company/settings/instance/experimental", "issues/<identifier>"]);
  const mounted = (page: string) => page
    .replace("apps/<connectionId>/permissions", "apps/:connectionId/:tab")
    .replace("issues/<identifier>", "issues/:issueId");
  for (const page of pages) expect(appRoutes, page).toContain(`<Route path="${mounted(page)}" element=`);
  expect(readFileSync(path.join(repoRoot, "ui/src/pages/apps/app-tabs.ts"), "utf8")).toContain("\"permissions\"");
});

it.each([
  "connect custom MCP server with server URL and API key BYO connection",
  "byo custom mcp server create tool app connection",
])("search %j sends an own-server API key to the secure page", (query) => {
  const found = searchRunnerApi({ query, limit: 10 }).results.filter(row => ["POST /api/companies/{companyId}/tools/apps/connect", "POST /api/companies/{companyId}/tools/connections"].includes(row.operationId));
  expect(found.length, query).toBeGreaterThan(0);
  for (const operation of found) expect(operation.description).toContain("[Connect your own MCP server](/<prefix>/apps/byo)");
});

it("links only mounted pages from connections_search", () => {
  const appRoutes = readFileSync(path.join(repoRoot, "ui/src/App.tsx"), "utf8");
  const search = readFileSync(path.join(repoRoot, "server/src/services/connection-intents.ts"), "utf8");
  for (const page of ["apps/byo", "company/settings/instance/experimental"]) {
    expect(search, page).toContain(`}/${page})`);
    expect(appRoutes, page).toContain(`<Route path="${page}" element=`);
  }
});
