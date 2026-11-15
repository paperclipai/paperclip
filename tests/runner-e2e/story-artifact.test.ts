import { expect, it } from "vitest";
import { parseArtifactOracleChecks } from "./story-artifact.js";

it("preserves the independent oracle's named failing checks on its documented exit 1", () => {
  const checks = [{ id: "separator-underscore", passed: false, detail: "Expected queue_ready; received queue-ready" }];
  expect(parseArtifactOracleChecks(JSON.stringify({ passed: false, checks }), 1)).toEqual(checks);
  expect(() => parseArtifactOracleChecks(JSON.stringify({ passed: false, checks }), 1, true)).toThrow("artifact_oracle_preflight_failed");
});
it("accepts valid success but rejects malformed, contradictory and process-failure receipts", () => {
  const checks = [{ id: "cli-output", passed: true, detail: "Independent input matched" }];
  const output = JSON.stringify({ passed: true, checks });
  expect(parseArtifactOracleChecks(output, 0)).toEqual(checks);
  for (const [body, code] of [[output, 1], [output, 2], ["not json", 0], [JSON.stringify({ passed: true, checks: [] }), 0],
    [JSON.stringify({ passed: true, checks: [{ ...checks[0], passed: false }] }), 0]] as const) {
    expect(() => parseArtifactOracleChecks(body, code)).toThrow();
  }
});
