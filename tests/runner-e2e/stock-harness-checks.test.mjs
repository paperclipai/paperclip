import { describe, expect, it } from "vitest";
import { assertPreflightReceipt, gradeGate, stockHarnessGates, stockHarnessGatesForVariant } from "./stock-harness-checks.mjs";
import { readStockInstructionVariant } from "./stock-harness-instruction-variant.mjs";

const gate = { id: "SH-test", name: "Boundary", files: ["boundary.test.ts"], required: ["must preserve instructions"] };
const report = () => ({ testResults: [{ name: "/repo/boundary.test.ts", status: "passed",
  assertionResults: [{ fullName: "Boundary must preserve instructions", status: "passed" }] }],
numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 });
describe("stock harness prerequisite coverage", () => {
  it("maps every implemented change to an executable gate", () => {
    expect(stockHarnessGates.map(gate => gate.id)).toEqual(["SH-1", "SH-2", "SH-3", "SH-3-hermes", "SH-eval"]);
    expect(stockHarnessGates.every(gate => gate.files.length > 0 && gate.required.length > 0)).toBe(true);
  });
  it("accepts an executed passing boundary", () => expect(gradeGate(gate, report(), 0).passed).toBe(true));
  it("preserves candidate assertions and admits only declared historical structural alternatives", () => {
    expect(stockHarnessGatesForVariant("reduced")).toEqual(stockHarnessGates);
    const historical = stockHarnessGatesForVariant("historical");
    expect(historical.map(value => value.files)).toEqual(stockHarnessGates.map(value => value.files));
    expect(historical.find(value => value.id === "SH-2").required).toContain("materializes the bundled default instruction set for non-CEO agents with no prompt template");
    expect(historical.find(value => value.id === "SH-3").required).toContain("adds the execution contract to resume delta prompts and opted-in fresh prompts");
    expect(historical.find(value => value.id === "SH-3").required).toContain("integrates the env-free store");
    expect(() => stockHarnessGatesForVariant("other")).toThrow("Unknown");
  });
  it.each([null, undefined, { testResults: [] }])("rejects unavailable evidence %s", (report) => {
    expect(gradeGate(gate, report, 0).passed).toBe(false);
  });
  it.each(["pending", "skipped", "failed", "todo"])("rejects a %s required assertion", (status) => {
    const observation = report();
    observation.testResults[0].assertionResults[0].status = status;
    expect(gradeGate(gate, observation, 0).passed).toBe(false);
  });
  it("rejects a passing different assertion and a nonzero launcher exit", () => {
    const different = report();
    different.testResults[0].assertionResults[0].fullName = "Unrelated pass";
    expect(gradeGate(gate, different, 0).passed).toBe(false);
    expect(gradeGate(gate, report(), 1).passed).toBe(false);
  });
  it("allows explicitly filtered unrelated tests while rejecting a skipped required test", () => {
    const filtered = { ...gate, testPattern: "must preserve instructions" };
    const observation = report();
    observation.testResults[0].assertionResults.push({ fullName: "Unrelated", status: "skipped" });
    expect(gradeGate(filtered, observation, 0).passed).toBe(true);
    observation.testResults[0].assertionResults[0].status = "skipped";
    expect(gradeGate(filtered, observation, 0).passed).toBe(false);
  });
  it("rejects a requested file absent from Vitest discovery even when required names pass", () => {
    expect(gradeGate({ ...gate, files: [...gate.files, "undiscovered.test.ts"] }, report(), 0).passed).toBe(false);
    expect(stockHarnessGates.find(gate => gate.id === "SH-3-hermes").cwd).toBe("packages/adapters/hermes");
  });
});

describe("stock harness prerequisite admission", () => {
  const current = { sha: "a".repeat(40), fingerprint: "b".repeat(64), runnerdSha256: "c".repeat(64), fakeCodexSha256: "e".repeat(64) };
  const receipt = () => ({ schema: "paperclip.stock-harness-preflight.v3", passed: true,
    instructionVariant: (({ variant, sha256 }) => ({ variant, sha256 }))(readStockInstructionVariant()),
    setup: { passed: true, exitCode: 0, sdkExitCode: 0, runnerdExitCode: 0, runnerdSha256: current.runnerdSha256,
      fakeCodexSha256: current.fakeCodexSha256 },
    providerCalls: 0, sourceSha: current.sha, sourceFingerprint: current.fingerprint,
    sourceErrors: [], gates: [...stockHarnessGates.map(g => g.id), "SH-1-rust"].map(id => ({ id, passed: true, exitCode: 0 })) });
  it("admits the same passing source revision", () => expect(assertPreflightReceipt(receipt(), current).passed).toBe(true));
  it.each([
    ["old SHA", r => { r.sourceSha = "c".repeat(40); }],
    ["changed source", r => { r.sourceFingerprint = "d".repeat(64); }],
    ["wrong instruction variant", r => { r.instructionVariant.variant = "other"; }],
    ["wrong manual hash", r => { r.instructionVariant.sha256 = "f".repeat(64); }],
    ["failed boundary", r => { r.gates[0].passed = false; }],
    ["nonzero exit", r => { r.gates[0].exitCode = 1; }],
    ["missing Rust", r => { r.gates.pop(); }],
    ["duplicate boundary", r => { r.gates[1] = r.gates[0]; }],
    ["provider calls", r => { r.providerCalls = 1; }],
    ["missing source", r => { r.sourceErrors.push("missing.ts"); }],
    ["failed cold setup", r => { r.setup.passed = false; r.setup.exitCode = 1; }],
    ["missing daemon build", r => { delete r.setup.runnerdExitCode; }],
    ["changed daemon binary", r => { r.setup.runnerdSha256 = "d".repeat(64); }],
    ["changed protocol fixture", r => { r.setup.fakeCodexSha256 = "d".repeat(64); }],
  ])("rejects %s before providers", (_name, mutate) => {
    const r = receipt(); mutate(r); expect(() => assertPreflightReceipt(r, current)).toThrow("exact source SHA and fingerprint");
  });
});
