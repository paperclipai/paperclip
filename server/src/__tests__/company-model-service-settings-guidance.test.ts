import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

// An agent asked to turn on a company model service cannot do it and must link the page that holds the control.
// The general /company/settings page has none of these sections, so the catalog names the Connections page.
it.each([
  ["fast response feature", "/api/companies/{companyId}/fast-response", "Fast response"],
  ["company settings page fast responses web UI", "/api/companies/{companyId}/fast-response", "Fast response"],
  ["decision model settings", "/api/companies/{companyId}/decision-model", "Decision model"],
  ["prompt injection prevention settings", "/api/companies/{companyId}/prompt-injection-prevention", "Prompt Injection Prevention"],
])("search %j returns the settings page that holds the %s control", (query, path, section) => {
  const operation = searchRunnerApi({ query, limit: 10 }).results.find(row => row.path === path && row.method === "PUT");
  expect(operation, query).toBeDefined();
  expect(operation!.description).toContain(`${section} section of the company-prefixed /company/settings/connections page`);
  expect(operation!.description).toContain("/<prefix>/company/settings/connections");
});

it("names the experiment that hides the Fast response section", () => {
  const operation = searchRunnerApi({ query: "fast response", limit: 10 }).results.find(row => row.operationId === "GET /api/companies/{companyId}/fast-response");
  expect(operation?.description).toContain("/<prefix>/company/settings/instance/experimental");
});
