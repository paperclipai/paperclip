import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildOpenApiDocument, applyPluginSettingsVisibility } from "../routes/openapi.js";
import { runnerApiCatalog, searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const settingsLink = "[plugin settings](/<prefix>/company/settings/instance/plugins/<pluginId>)";

// Queries an agent searched after reading a routine whose `managedByPlugin` was set.
it.each([
  "plugin managed routine",
  "plugin routine managed definition",
  "managedByPlugin",
  "detach plugin managed routine",
  "update routine",
])("search %j explains who owns a plugin-managed routine and links its settings", (query) => {
  const found = searchRunnerApi({ query, limit: 10 }).results
    .filter(row => row.path === "/api/routines/{id}" && (row.method === "GET" || row.method === "PATCH"));
  expect(found.length, query).toBeGreaterThan(0);
  for (const operation of found) {
    expect(operation.description).toContain("managedByPlugin");
    expect(operation.description).toContain(settingsLink);
    expect(operation.description).toContain("Do not rewrite, detach or duplicate");
  }
});

it("links a plugin settings page the board UI mounts", () => {
  const appRoutes = readFileSync(path.join(repoRoot, "ui/src/App.tsx"), "utf8");
  expect(appRoutes).toContain('path="company/settings/instance/plugins/:pluginId"');
});

it.each(["GET /api/routines/{id}", "PATCH /api/routines/{id}"])("%s carries the full plugin-managed routine guidance", (operationId) => {
  const description = runnerApiCatalog().find(row => row.operationId === operationId)?.description ?? "";
  expect(description).toContain("managedByPlugin");
  expect(description).toContain(settingsLink);
  expect(description).toContain("Do not rewrite, detach or duplicate");
  expect(description).toContain("reply now with that link");
});

it("names the hosting operator instead of linking plugin settings when the operator hides them", () => {
  const document = applyPluginSettingsVisibility(buildOpenApiDocument(), new Set(["instance.plugins"]));
  for (const operation of [document.paths["/api/routines/{id}"].get, document.paths["/api/routines/{id}"].patch]) {
    expect(operation.description).not.toContain("/company/settings/instance/plugins");
    expect(operation.description).toContain("the hosting operator controls this plugin's settings");
    expect(operation.description).toContain("Do not rewrite, detach or duplicate");
  }
  const visible = applyPluginSettingsVisibility(buildOpenApiDocument(), new Set());
  expect(visible.paths["/api/routines/{id}"].get.description).toContain(settingsLink);
});
