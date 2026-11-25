import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_SWARM_CASES, ANTIGRAVITY_SWARM_SUITE } from "./antigravity-swarm-cases.js";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { buildMatrixJobs, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

const select = (...args: string[]) => selectRunnerExecutions(parseRunnerSelectors(args));

describe("Antigravity swarm cells", () => {
  it("lists one attended local cell per swarm behaviour, needing the CLI route and a Google sign-in", () => {
    const suite = runnerSuites.find(entry => entry.id === ANTIGRAVITY_SWARM_SUITE)!;
    expect(suite).toMatchObject({ manualOnly: true, definitionMetadata: expect.objectContaining({ route: "antigravity-cli", authentication: expect.stringMatching(/google-sign-in/) }) });
    const cells = runnerMatrix.filter(row => row.suite.id === ANTIGRAVITY_SWARM_SUITE);
    expect(cells.map(cell => cell.task.id).sort()).toEqual([...ANTIGRAVITY_SWARM_CASES].sort());
    expect(new Set(cells.map(cell => cell.environment.id))).toEqual(new Set(["local"]));
    expect(cells.every(cell => cell.task.flow === "antigravity_swarm_journey")).toBe(true);
  });

  it("is selectable by name but never part of the default run or CI matrix jobs", () => {
    expect(select("--list", "--suite", ANTIGRAVITY_SWARM_SUITE)).toHaveLength(ANTIGRAVITY_SWARM_CASES.length);
    expect(select("--all").some(execution => execution.suite.id === ANTIGRAVITY_SWARM_SUITE)).toBe(false);
    expect(() => buildMatrixJobs(select("--suite", ANTIGRAVITY_SWARM_SUITE))).toThrow("Attended connection journeys");
  });
});
