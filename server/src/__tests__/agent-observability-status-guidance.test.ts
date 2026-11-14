import { expect, it } from "vitest";
import { runnerApiOperation, searchRunnerApi, withCompanyPagePaths } from "../services/native-runtime/runner-api-catalog.js";

const STATUS = "GET /api/companies/{companyId}/observability/status";

it.each([
  "test collector configuration",
  "agent traces otlp collector",
  "observability export enabled",
])("search %j finds the agent-readable trace export status", (query) => {
  expect(searchRunnerApi({ query, limit: 10 }).results.map(row => row.operationId)).toContain(STATUS);
});

it("lets the company's agents read trace export status, and keeps the settings board-only", () => {
  expect(runnerApiOperation(STATUS).authorization).toEqual({ actor: "board_or_agent" });
  expect(runnerApiOperation("GET /api/companies/{companyId}/observability").authorization).toEqual({ actor: "board" });
});

it("hands the agent real company page paths instead of the /<prefix>/ placeholder", () => {
  const found = searchRunnerApi({ query: STATUS, limit: 1 });
  expect(JSON.stringify(found)).toContain("/<prefix>/company/settings");
  const localized = withCompanyPagePaths(found, "COM");
  expect(JSON.stringify(localized)).not.toContain("<prefix>");
  expect(localized.results[0]!.description).toContain("/COM/company/settings");
  // The shared catalog is not mutated.
  expect(runnerApiOperation(STATUS).description).toContain("/<prefix>/company/settings");
  expect(withCompanyPagePaths(found, null)).toBe(found);
});
