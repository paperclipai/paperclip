import { expect, it } from "vitest";
import { selectRunnerExecutions, parseRunnerSelectors } from "./selectors.js";
import { productRegressionCases } from "./product-regression-testops.mjs";

it("runs every standing Product regression case through its existing full-stack fixture", () => {
  const executions = selectRunnerExecutions(parseRunnerSelectors(
    productRegressionCases.flatMap(row => ["--id", row.executionId]),
  ));
  expect(executions).toHaveLength(20);
  for (const row of productRegressionCases) {
    const execution = executions.find(value => value.id === row.executionId)!;
    expect(execution.suite.id).toBe(row.suite);
    expect(execution.task.id).toBe(row.name);
    expect(execution.profile.id).toBe(row.profile);
    expect(execution.environment.id).toBe("local");
    expect(execution.requiredCredentials).not.toContain("CODEX_AUTH_JSON");
  }
});
