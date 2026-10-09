import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runnerSuites, buildRunnerMatrix } from "./catalog.js";
import { gradeNativeDefault, NATIVE_MASTER_DEFAULT_SHA256 } from "./native-completion-defaults.js";
import { nativeCompletionTasks } from "./native-completion-cases.js";
import { assertNativeInstructionLineage, assertNativeInstructionSelection, nativeInstructionVariant, validateNativeInstructionMeasurement, NATIVE_INSTRUCTION_BASE_SHA, NATIVE_INSTRUCTION_DEFAULT_SHA256, NATIVE_INSTRUCTION_SUITE, NATIVE_INSTRUCTION_VARIANTS } from "./native-instruction-consolidation.js";

describe("native instruction comparison admission", () => {
  it("proves real hosted ancestry when the source is more than eight commits from the base", () => {
    const temporary = mkdtempSync(join(tmpdir(), "native-instruction-lineage-"));
    const source = join(temporary, "source");
    const checkout = join(temporary, "checkout");
    const environment = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const fixtureGit = (cwd: string, args: string[]) => execFileSync("git", args, {
      cwd, env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    try {
      fixtureGit(temporary, ["init", "--quiet", source]);
      writeFileSync(join(source, "source.txt"), "Immutable source fixture\n");
      fixtureGit(source, ["add", "source.txt"]);
      const tree = fixtureGit(source, ["write-tree"]);
      const base = fixtureGit(source, ["commit-tree", tree, "-m", "base"]);
      let head = base;
      for (let index = 0; index < 12; index++)
        head = fixtureGit(source, ["commit-tree", tree, "-p", head, "-m", `source ${index}`]);
      fixtureGit(source, ["update-ref", "refs/heads/fixture", head]);
      fixtureGit(temporary, ["clone", "--quiet", "--depth=1", "--branch=fixture", pathToFileURL(source).href, checkout]);
      const run = (...args: string[]) => fixtureGit(checkout, ["--no-replace-objects", ...args.map(value =>
        value === NATIVE_INSTRUCTION_BASE_SHA ? base
          : value === "https://github.com/paperclipai/paperclip.git" ? pathToFileURL(source).href : value)]);
      expect(() => run("merge-base", "--is-ancestor", NATIVE_INSTRUCTION_BASE_SHA, head)).toThrow();
      expect(() => assertNativeInstructionLineage(head, run, true)).not.toThrow();
      expect(run("rev-parse", "HEAD")).toBe(head);
      expect(() => run("merge-base", "--is-ancestor", NATIVE_INSTRUCTION_BASE_SHA, head)).not.toThrow();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("hydrates bounded hosted history and still requires exact HEAD and real base ancestry", () => {
    const head = "a".repeat(40);
    for (const scenario of ["valid", "changed-head", "no-base", "local", "not-shallow"]) {
      let hydrated = false;
      const calls: string[][] = [];
      const run = (...args: string[]) => {
        calls.push(args);
        if (args[0] === "merge-base") {
          if (!hydrated || scenario === "no-base") throw new Error("no declared ancestor");
          return "";
        }
        if (args[1] === "--is-shallow-repository") return scenario === "not-shallow" ? "false" : "true";
        if (args.includes("fetch")) { hydrated = true; return ""; }
        return scenario === "changed-head" ? "b".repeat(40) : head;
      };
      if (scenario === "valid") expect(() => assertNativeInstructionLineage(head, run, true)).not.toThrow();
      else expect(() => assertNativeInstructionLineage(head, run, scenario !== "local")).toThrow();
      const fetches = calls.filter(args => args.includes("fetch"));
      const depths = ["local", "not-shallow"].includes(scenario) ? [] : scenario === "no-base" ? [8, 32, 128] : [8];
      expect(fetches).toEqual(depths.map(depth => ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
        "fetch", "--no-tags", `--depth=${depth}`, "https://github.com/paperclipai/paperclip.git", head]));
    }
  });
  it("accepts each complete source variant and rejects a mixed variant", () => {
    const files = Object.keys(NATIVE_INSTRUCTION_VARIANTS.baseline);
    const baseline = new Map(files.map(file => [file, execFileSync("git", ["show", `${NATIVE_INSTRUCTION_BASE_SHA}:${file}`])]));
    expect(nativeInstructionVariant(file => baseline.get(file)!)).toBe("baseline");
    // This historical admission intentionally rejects later production changes.
    // Exercise the retained qualified tree rather than requiring HEAD to remain
    // one of this completed comparison's frozen variants forever.
    const candidate = new Map(files.map(file => [file, execFileSync("git", ["show", `16ef1a5744b23bb043a8b286e6288921da1de98f:${file}`])]));
    const currentVariant = nativeInstructionVariant(file => candidate.get(file)!);
    expect(["baseline", "candidate", "corrected", "feedback", "opencodeFeedback", "opencodeFeedbackSettlement", "opencodeFeedbackResponses"]).toContain(currentVariant);
    candidate.set(files[0]!, currentVariant === "candidate" ? baseline.get(files[0]!)! : Buffer.from("unknown source"));
    expect(() => nativeInstructionVariant(file => candidate.get(file)!)).toThrow("Mixed or unknown");
    baseline.set(files[0]!, Buffer.from("unknown source"));
    expect(() => nativeInstructionVariant(file => baseline.get(file)!)).toThrow("Mixed or unknown");
  });

  it("declares six explicit single-attempt cells with the original task prompts and oracle", () => {
    const suite = runnerSuites.find(value => value.id === NATIVE_INSTRUCTION_SUITE)!;
    expect(suite.tasks).toEqual(nativeCompletionTasks);
    expect(suite.manualOnly).toBe(true);
    expect(suite.environments.map(value => value.id)).toEqual(["local"]);
    const executions = buildRunnerMatrix([suite]);
    expect(executions).toHaveLength(6);
    expect(() => assertNativeInstructionSelection(executions)).not.toThrow();
    for (const execution of executions) {
      expect(execution.task.expectedRunCount).toBe(1);
      expect(execution.task.automaticRetryPolicy).toBe("single_attempt");
      expect(() => assertNativeInstructionSelection([{ ...execution, environment: { ...execution.environment, id: "daytona" } }])).toThrow();
      expect(() => assertNativeInstructionSelection([{ ...execution, task: { ...execution.task, automaticRetryPolicy: undefined } }])).toThrow();
    }
  });

  it("uses the new common production default without qualifying old default evidence", () => {
    const receipt = { schema: "paperclip.native-completion-default.v1" as const, companyId: "company", agentId: "agent", entryFile: "AGENTS.md",
      files: [{ path: "AGENTS.md", sha256: NATIVE_INSTRUCTION_DEFAULT_SHA256, bytes: 40 }], budgets: { company: 1000, agent: 1000 } };
    expect(gradeNativeDefault(receipt, NATIVE_INSTRUCTION_DEFAULT_SHA256).passed).toBe(true);
    expect(gradeNativeDefault(receipt).passed).toBe(false);
    receipt.files[0]!.sha256 = NATIVE_MASTER_DEFAULT_SHA256;
    expect(gradeNativeDefault(receipt, NATIVE_INSTRUCTION_DEFAULT_SHA256).passed).toBe(false);
    receipt.files[0]!.sha256 = NATIVE_INSTRUCTION_DEFAULT_SHA256;
    receipt.budgets.company = 0;
    expect(gradeNativeDefault(receipt, NATIVE_INSTRUCTION_DEFAULT_SHA256).passed).toBe(false);
  });

  it("rejects duplicate or incomplete capture, dirty or paid source, and stale fixture evidence", () => {
    const measurement = {
      schema: "paperclip.native-instruction-measurement.v2", sourceSha: "frozen", sourceDirty: false, providerCalls: 0,
      fixtureSha256: createHash("sha256").update(readFileSync(new URL("../../packages/paperclip-runner/src/backends/native-instruction-measurement.test.ts", import.meta.url))).digest("hex"),
      sourceHashes: Object.fromEntries(Object.entries(NATIVE_INSTRUCTION_VARIANTS.baseline).map(([file, digest]) => [file.split('/').at(-1)!, digest])),
      directOpenCodeReceipts: ["v4", "v5"].flatMap(schema => ["start", "resume", "continuation"].map(phase => ({ provider: "opencode", schema, phase }))),
      receipts: ['codex', 'acpx', 'opencode'].flatMap(provider => ['v4', 'v5'].flatMap(schema => ['start', 'resume', 'continuation'].map(phase => ({ provider, schema, phase })))),
    };
    const source = { sourceSha: "frozen", variant: "baseline" };
    expect(() => validateNativeInstructionMeasurement(measurement, source)).not.toThrow();
    for (const invalid of [
      { ...measurement, receipts: measurement.receipts.slice(1) },
      { ...measurement, directOpenCodeReceipts: undefined },
      { ...measurement, directOpenCodeReceipts: measurement.directOpenCodeReceipts.slice(1) },
      { ...measurement, directOpenCodeReceipts: measurement.directOpenCodeReceipts.map(() => measurement.directOpenCodeReceipts[0]!) },
      { ...measurement, receipts: measurement.receipts.map(() => measurement.receipts[0]!) },
      { ...measurement, sourceDirty: true }, { ...measurement, providerCalls: 1 },
      { ...measurement, sourceSha: "other" }, { ...measurement, fixtureSha256: "stale" },
      { ...measurement, sourceHashes: { ...measurement.sourceHashes, "runtime-context.ts": "wrong" } },
      { ...measurement, sourceHashes: { ...measurement.sourceHashes, "opencode-app-server-proxy.ts": "wrong" } },
    ]) expect(() => validateNativeInstructionMeasurement(invalid, source)).toThrow();
  });
});
