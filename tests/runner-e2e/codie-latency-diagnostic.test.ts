import { describe, expect, it } from "vitest";
import { runnerSuites } from "./catalog.js";
import { effectiveAutomaticRetryLimit } from "./automatic-retry.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

describe("explicit native latency diagnostic", () => {
  const suiteId = "codie-latency-diagnostic";
  it("selects only one explicit real-Daytona cell and stays out of all", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--suite", suiteId]));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ profile: { model: "gpt-6.1-sol", generation: "native" }, environment: { id: "daytona" } });
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === suiteId)).toBe(false);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--profile", "runner-codex"])).some(cell => cell.suite.id === suiteId)).toBe(false);
  });
  it("enforces one paid attempt even when the command requests retries", () => {
    const [cell] = selectRunnerExecutions(parseRunnerSelectors(["--suite", suiteId]));
    expect(effectiveAutomaticRetryLimit(cell!.task, 99)).toBe(0);
  });
  it("declares the authentication and staging-fidelity limits", () => {
    expect(runnerSuites.find(suite => suite.id === suiteId)?.definitionMetadata).toMatchObject({
      diagnostic: true, providerAuth: "api_key", stagingAuth: "subscription", companyData: "fresh-fixture", slackDelivery: false, maximumAutomaticRetries: 0,
    });
  });
});
