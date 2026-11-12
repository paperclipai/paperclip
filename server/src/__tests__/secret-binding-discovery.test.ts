import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

it("finds the secret binding proposal when an agent searches for how to give an agent a company secret", () => {
  for (const query of [
    "agent configuration update env secret",
    "agent environment variables set secret ref",
    "agent configuration environment variables bind secret reference",
    "give agent access to company secret",
  ]) {
    const { results } = searchRunnerApi({ query, limit: 3 });
    expect(results.map(operation => operation.operationId), query).toContain("POST /api/agents/me/secret-proposals");
  }
  const operation = searchRunnerApi({ query: "POST /api/agents/me/secret-proposals" }).results[0]!;
  expect(operation.description).toContain("configPath");
  expect(operation.description).toContain("targetAgentId");
});
