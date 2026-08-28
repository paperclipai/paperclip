import { describe, expect, it } from "vitest";
import type { SmokeRun, SmokeRunStep } from "@paperclipai/shared";
import {
  buildSmokeMatrix,
  cellKey,
  failingPaths,
  matchLifecycleStage,
  runHealth,
} from "./smoke-lab-matrix";

function step(overrides: Partial<SmokeRunStep> & Pick<SmokeRunStep, "path" | "scenarioStep" | "status">): SmokeRunStep {
  return {
    id: `${overrides.path}-${overrides.scenarioStep}`,
    companyId: "c1",
    runId: "r1",
    detail: null,
    screenshotArtifactRef: null,
    durationMs: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

function run(overrides: Partial<SmokeRun> = {}): SmokeRun {
  return {
    id: "r1",
    companyId: "c1",
    trigger: "manual",
    status: "passed",
    startedAt: "2026-07-10T00:00:00Z",
    finishedAt: "2026-07-10T00:05:00Z",
    summary: {},
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:05:00Z",
    ...overrides,
  };
}

describe("matchLifecycleStage", () => {
  it("folds catalog scenario wording onto canonical stages", () => {
    expect(matchLifecycleStage("oauth-login")).toBe("connect");
    expect(matchLifecycleStage("discover-catalog")).toBe("discover");
    expect(matchLifecycleStage("allowed-read")).toBe("read");
    expect(matchLifecycleStage("ask-first-write-approve")).toBe("write");
    expect(matchLifecycleStage("denied-call")).toBe("deny");
    expect(matchLifecycleStage("schema-change-quarantine")).toBe("quarantine");
    expect(matchLifecycleStage("revoke-token")).toBe("revoke");
    expect(matchLifecycleStage("audit-evidence")).toBe("audit");
  });

  it("returns null for steps that don't map to a lifecycle stage", () => {
    expect(matchLifecycleStage("warm-up")).toBeNull();
  });
});

describe("buildSmokeMatrix", () => {
  it("keeps the latest status per (path, stage) cell", () => {
    const steps = [
      step({ path: "P1", scenarioStep: "connect", status: "fail", updatedAt: "2026-07-10T00:00:01Z" }),
      step({ path: "P1", scenarioStep: "connect-retry", status: "pass", updatedAt: "2026-07-10T00:00:02Z" }),
      step({ path: "P2", scenarioStep: "revoke", status: "skipped", updatedAt: "2026-07-10T00:00:03Z" }),
    ];
    const matrix = buildSmokeMatrix(steps);
    expect(matrix.get(cellKey("P1", "connect"))?.status).toBe("pass");
    expect(matrix.get(cellKey("P2", "revoke"))?.status).toBe("skipped");
    expect(matrix.get(cellKey("P3", "connect"))).toBeUndefined();
  });
});

describe("runHealth + failingPaths", () => {
  it("is red when any step fails", () => {
    const steps = [step({ path: "P4", scenarioStep: "connect", status: "fail" })];
    expect(runHealth(run(), steps)).toBe("red");
    expect(failingPaths(steps)).toEqual(["P4"]);
  });

  it("is green for a passed run with passing steps", () => {
    const steps = [step({ path: "P1", scenarioStep: "connect", status: "pass" })];
    expect(runHealth(run({ status: "passed" }), steps)).toBe("green");
  });

  it("is amber for a running run or an empty run", () => {
    expect(runHealth(run({ status: "running" }), [])).toBe("amber");
    expect(runHealth(run({ status: "passed" }), [])).toBe("amber");
  });

  it("is unknown when there is no run", () => {
    expect(runHealth(undefined, [])).toBe("unknown");
  });
});
