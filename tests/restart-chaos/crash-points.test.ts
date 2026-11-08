import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CrashPointDefinition, CrashPointName } from "../../packages/shared/src/crash-point-registry.js";
import { classifyPoint, globToRegExp, parseSuiteArgs, renderSummary, selectPoints, type CrashPointEntry } from "./crash-points.js";
import { parseCommand } from "./config.js";
import { readCrashPointReceipt } from "./supervisor.js";

const definition = (kinds: string[], environments: Array<"local" | "daytona"> = ["local", "daytona"]): CrashPointDefinition => ({
  description: "test point description long enough", kinds, invariants: ["I2"], environments,
});
const registry: Record<string, CrashPointDefinition> = {
  "runner.startup.after_spawn": definition(["native_startup_context"]),
  "sandbox.create.after_provider_before_lease": definition(["sandbox_creation_intent"], ["daytona"]),
  "wake.request.after_claim_before_run": definition(["wake_request_claimed"]),
};
const point = "runner.startup.after_spawn" as CrashPointName;

describe("selectPoints", () => {
  it("filters by glob, kind and environment", () => {
    expect(selectPoints(registry, { points: [], kinds: [], env: "local" }))
      .toEqual(["runner.startup.after_spawn", "wake.request.after_claim_before_run"]);
    expect(selectPoints(registry, { points: ["runner.*"], kinds: [], env: "local" })).toEqual(["runner.startup.after_spawn"]);
    expect(selectPoints(registry, { points: [], kinds: ["sandbox_creation_intent"], env: "daytona" }))
      .toEqual(["sandbox.create.after_provider_before_lease"]);
    expect(selectPoints(registry, { points: [], kinds: ["sandbox_creation_intent"], env: "local" })).toEqual([]);
  });

  it("matches globs literally apart from * and ?", () => {
    expect(globToRegExp("runner.*").test("runnerXstartup")).toBe(false);
    expect(globToRegExp("*.after_?pawn").test("runner.startup.after_spawn")).toBe(true);
  });
});

describe("parseSuiteArgs", () => {
  it("defaults to one local codex A1 task per point", () => {
    expect(parseSuiteArgs([])).toMatchObject({ env: "local", adapters: ["codex"], workloads: ["A1"], nth: 1, list: false, passthrough: [] });
  });

  it("passes harness options through and refuses unknown values", () => {
    expect(parseSuiteArgs(["--", "--keep", "--budget-cents", "500"]).passthrough).toEqual(["--budget-cents", "500", "--keep"]);
    expect(() => parseSuiteArgs(["--adapters", "gpt"])).toThrow(/Unknown adapter/);
    expect(() => parseSuiteArgs(["--nth", "0"])).toThrow(/positive integer/);
  });
});

describe("classifyPoint", () => {
  const entry = (overrides: Partial<CrashPointEntry> = {}): CrashPointEntry => ({
    point: `${point}:1`, reached: { name: point, hit: 1, pid: 42 }, armedAt: 0, restedAt: 120_000,
    tasks: [{ taskId: "t01", adapter: "codex", workload: "A1", pass: true, signature: null, rules: { R1: "pass" } }],
    invariants: { violations: [], byInvariant: {}, errors: [] },
    ...overrides,
  });

  it("passes a reached point with no failed task or new violation, timed from arming to rest", () => {
    expect(classifyPoint(point, 0, entry())).toMatchObject({ outcome: "pass", durationMs: 120_000 });
  });

  it("fails on a new invariant violation or a failed task, even when not reached", () => {
    const violation = { rule: "I2_settled", kind: "native_executor_claim", reason: "owner_run_terminal", recordId: "r1" };
    expect(classifyPoint(point, 1, entry({ invariants: { violations: [violation], byInvariant: { I2: 1 }, errors: [] } })))
      .toMatchObject({ outcome: "fail", failedInvariants: { I2: 1 } });
    expect(classifyPoint(point, 1, entry({ reached: null,
      tasks: [{ taskId: "t01", adapter: "codex", workload: "A1", pass: false, signature: "x", rules: { R1: "fail" } }] })).outcome).toBe("fail");
  });

  it("separates unreached, unrun and unchecked points", () => {
    expect(classifyPoint(point, 0, entry({ reached: null })).outcome).toBe("not_reached");
    expect(classifyPoint(point, 2, null)).toMatchObject({ outcome: "harness_error", error: "not run (wave exited 2)" });
    expect(classifyPoint(point, 0, entry({ invariants: null })).outcome).toBe("harness_error");
    expect(classifyPoint(point, 0, entry({ invariants: { violations: [], byInvariant: {}, errors: ["I3 pass did not finish"] } })).outcome)
      .toBe("harness_error");
  });

  it("renders a summary row per point", () => {
    const result = { ...classifyPoint(point, 0, entry()), waveDir: null };
    expect(renderSummary("cp-x", parseSuiteArgs([]), [result])).toContain("| `runner.startup.after_spawn` | pass | — | — | 2.0 |");
  });
});

describe("readCrashPointReceipt", () => {
  it("returns the receipt line of the given pid only", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crash-receipt-"));
    try {
      const file = path.join(dir, "receipts.jsonl");
      writeFileSync(file, `${JSON.stringify({ point, hit: 1, pid: 7 })}\n{"partial`);
      expect(readCrashPointReceipt(file, 7)).toEqual({ name: point, hit: 1, pid: 7 });
      expect(readCrashPointReceipt(file, 8)).toBeNull();
      expect(readCrashPointReceipt(path.join(dir, "missing"), 7)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main.ts --crash-point", () => {
  it("plans a K1-only wave with the point and refuses scheduled-fault options", () => {
    const parsed = parseCommand(["--crash-point", `${point}:2`, "--tasks", "1", "--seed", "1"]);
    expect(parsed).toMatchObject({ mode: "wave", options: { crashPoint: `${point}:2`, faults: ["K1"] } });
    expect(() => parseCommand(["--crash-point", point, "--faults", "K2"])).toThrow(/replaces scheduled faults/);
    expect(() => parseCommand(["--crash-point", "Bad Name"])).toThrow(/<name>\[:<nth>\]/);
    expect(parseCommand(["--crash-point", `${point}:1,${point}:2`, "--tasks", "2"]))
      .toMatchObject({ options: { crashPoint: `${point}:1,${point}:2` } });
    expect(() => parseCommand(["--replay", "w-20261107T000000-s1/t01", "--crash-point", point])).toThrow(/--replay/);
  });
});
