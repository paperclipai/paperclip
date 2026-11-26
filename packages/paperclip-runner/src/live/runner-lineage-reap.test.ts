import { describe, expect, it } from "vitest";
import { parseRunnerLineageReapReport, RUNNER_LINEAGE_REAP_SCHEMA } from "./runner-lineage-reap.js";

describe("parseRunnerLineageReapReport", () => {
  const verified = { schema: RUNNER_LINEAGE_REAP_SCHEMA, verified: true, reason: null, journals: 1, signalled: 2, remaining: [] };

  it("accepts the report runnerd prints last", () => {
    expect(parseRunnerLineageReapReport(`warning\n${JSON.stringify(verified)}\n`)).toEqual(verified);
    const refused = { ...verified, verified: false, reason: "processes_remain", remaining: [42] };
    expect(parseRunnerLineageReapReport(JSON.stringify(refused))).toEqual(refused);
  });

  it.each([
    ["no output", null],
    ["an old runnerd's usage error", "unknown argument reap-lineage"],
    ["another schema", JSON.stringify({ ...verified, schema: "other" })],
    ["a verified report that names a survivor", JSON.stringify({ ...verified, remaining: [42] })],
    ["a verified report with a refusal reason", JSON.stringify({ ...verified, reason: "runner_alive" })],
    ["a malformed survivor list", JSON.stringify({ ...verified, verified: false, remaining: ["42"] })],
  ])("never treats %s as proof", (_label, stdout) => {
    expect(parseRunnerLineageReapReport(stdout)?.verified ?? false).toBe(false);
  });
});
