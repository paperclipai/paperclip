import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CRASH_POINTS,
  CRASH_POINT_NAME_PATTERN,
  CrashPointReached,
  armCrashPointForTest,
  armedCrashPoint,
  crashPoint,
  parseCrashPointControl,
  parseCrashPointSpec,
  type CrashPointName,
} from "./crash-points.js";

const names = Object.keys(CRASH_POINTS) as CrashPointName[];
const first = names[0]!;
const second = names[1]!;
let disarm: (() => void) | null = null;

afterEach(() => { disarm?.(); disarm = null; });

describe("crash point registry", () => {
  it("names every point <subsystem>.<record>.<before|after>_<step> with a description", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(CRASH_POINT_NAME_PATTERN);
      const definition = CRASH_POINTS[name];
      expect(definition.description.length, name).toBeGreaterThan(20);
      expect(definition.invariants.length, name).toBeGreaterThan(0);
      expect(definition.environments.length, name).toBeGreaterThan(0);
    }
  });
});

describe("parseCrashPointSpec", () => {
  it("reads a name and an optional hit count", () => {
    expect(parseCrashPointSpec(undefined)).toBeNull();
    expect(parseCrashPointSpec("  ")).toBeNull();
    expect(parseCrashPointSpec(first)).toEqual({ name: first, nth: 1 });
    expect(parseCrashPointSpec(`${first}:3`)).toEqual({ name: first, nth: 3 });
  });

  it("refuses unknown names and bad hit counts", () => {
    expect(() => parseCrashPointSpec("sandbox.create.after_typo")).toThrow(/unknown crash point/);
    expect(() => parseCrashPointSpec(`${first}:0`)).toThrow(/positive integer/);
    expect(() => parseCrashPointSpec(`${first}:x`)).toThrow(/positive integer/);
  });
});

describe("parseCrashPointControl", () => {
  it("reads a token and a spec, and treats anything else as disarmed", () => {
    expect(parseCrashPointControl(`t1 ${first}:3\n`)).toEqual({ token: "t1", spec: { name: first, nth: 3 } });
    expect(parseCrashPointControl("")).toBeNull();
    expect(parseCrashPointControl(first)).toBeNull();
    expect(parseCrashPointControl("t1 sandbox.create.after_typo")).toBeNull();
  });
});

describe("crashPoint in a test process", () => {
  it("does nothing while disarmed", () => {
    expect(armedCrashPoint()).toBeNull();
    expect(() => crashPoint(first)).not.toThrow();
  });

  it("throws at the nth hit of the armed name only", () => {
    disarm = armCrashPointForTest(`${first}:2`);
    crashPoint(second);
    crashPoint(first);
    expect(armedCrashPoint()).toEqual({ name: first, nth: 2, hits: 1 });
    expect(() => crashPoint(first)).toThrow(CrashPointReached);
    expect(() => crashPoint(first)).not.toThrow();
  });

  it("refuses an object spec with a count that could never fire", () => {
    for (const nth of [0, -1, 2.5, Number.NaN]) {
      expect(() => armCrashPointForTest({ name: first, nth })).toThrow(/positive integer/);
    }
    expect(armedCrashPoint()).toBeNull();
  });

  it("restores the previous state on disarm", () => {
    const off = armCrashPointForTest(first);
    off();
    expect(armedCrashPoint()).toBeNull();
  });
});

// Each case starts a child Node process with the tsx loader; allow for a busy host.
describe("crashPoint armed by the environment", { timeout: 60_000 }, () => {
  const script = (name: string) => [
    `const { crashPoint } = await import(${JSON.stringify(path.join(import.meta.dirname, "crash-points.ts"))});`,
    `crashPoint(${JSON.stringify(name)}); process.stdout.write("one\\n");`,
    `crashPoint(${JSON.stringify(name)}); process.stdout.write("two\\n");`,
  ].join("\n");
  // The loader, not the tsx CLI: the CLI runs the script in a child process, so
  // the SIGKILL would land on a grandchild.
  const tsxLoader = pathToFileURL(path.resolve(import.meta.dirname, "../../../cli/node_modules/tsx/dist/loader.mjs")).href;
  const runChild = (env: Record<string, string>, source = script(first)) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crash-point-script-"));
    try {
      const file = path.join(dir, "child.mts");
      writeFileSync(file, source);
      return spawnSync(process.execPath, ["--import", tsxLoader, file], {
        env: { ...process.env, NODE_ENV: "test", ...env }, encoding: "utf8", timeout: 60_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("SIGKILLs the process at the nth hit and appends a receipt", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crash-point-"));
    try {
      const receipt = path.join(dir, "receipt.jsonl");
      const result = runChild({ PAPERCLIP_CRASH_POINT: `${first}:2`, PAPERCLIP_CRASH_POINT_RECEIPT: receipt });
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toBe("one\n");
      expect(result.stderr).toContain(`[crash-point] armed ${first}:2`);
      expect(JSON.parse(readFileSync(receipt, "utf8").trim())).toMatchObject({ point: first, hit: 2, pid: result.pid });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores hits until the gate file exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crash-point-gate-"));
    try {
      const result = runChild({ PAPERCLIP_CRASH_POINT: first, PAPERCLIP_CRASH_POINT_GATE: path.join(dir, "open") });
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe("one\ntwo\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts hits only after the gate file appears", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crash-point-gate-"));
    try {
      const gate = path.join(dir, "open");
      const receipt = path.join(dir, "receipt.jsonl");
      const source = [
        `const { crashPoint } = await import(${JSON.stringify(path.join(import.meta.dirname, "crash-points.ts"))});`,
        `const { writeFileSync } = await import("node:fs");`,
        `crashPoint(${JSON.stringify(first)}); crashPoint(${JSON.stringify(first)}); process.stdout.write("closed\\n");`,
        `writeFileSync(${JSON.stringify(gate)}, "");`,
        `crashPoint(${JSON.stringify(first)}); process.stdout.write("one\\n");`,
        `crashPoint(${JSON.stringify(first)}); process.stdout.write("two\\n");`,
      ].join("\n");
      const result = runChild({ PAPERCLIP_CRASH_POINT: `${first}:2`, PAPERCLIP_CRASH_POINT_GATE: gate,
        PAPERCLIP_CRASH_POINT_RECEIPT: receipt }, source);
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toBe("closed\none\n");
      expect(JSON.parse(readFileSync(receipt, "utf8").trim())).toMatchObject({ point: first, hit: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arms at runtime from the control file and resets the count on a new token", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crash-point-control-"));
    try {
      const control = path.join(dir, "control");
      const receipt = path.join(dir, "receipt.jsonl");
      const hit = `crashPoint(${JSON.stringify(first)});`;
      const source = [
        `const { crashPoint } = await import(${JSON.stringify(path.join(import.meta.dirname, "crash-points.ts"))});`,
        `const { writeFileSync } = await import("node:fs");`,
        `${hit} process.stdout.write("absent\\n");`,
        `writeFileSync(${JSON.stringify(control)}, "t1 ${first}:2\\n");`,
        `${hit} process.stdout.write("t1-one\\n");`,
        `writeFileSync(${JSON.stringify(control)}, "t2 ${first}:2\\n");`,
        `${hit} process.stdout.write("t2-one\\n");`,
        `${hit} process.stdout.write("t2-two\\n");`,
      ].join("\n");
      const result = runChild({ PAPERCLIP_CRASH_POINT_CONTROL: control, PAPERCLIP_CRASH_POINT_RECEIPT: receipt }, source);
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toBe("absent\nt1-one\nt2-one\n");
      expect(JSON.parse(readFileSync(receipt, "utf8").trim())).toMatchObject({ point: first, hit: 2, token: "t2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays disarmed in production", () => {
    const result = runChild({ PAPERCLIP_CRASH_POINT: first, NODE_ENV: "production" });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("one\ntwo\n");
  });

  it("refuses an unknown name at import", () => {
    const result = runChild({ PAPERCLIP_CRASH_POINT: "sandbox.create.after_typo" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown crash point");
  });
});

describe("disarmed cost", () => {
  // TTFT is a hard constraint (plan invariant 8): a disarmed point must cost
  // about as much as an empty call. A regression that matters (a syscall or
  // I/O on the disarmed path) costs microseconds, so the bound is 100 ns over
  // an empty call: far above timer and load noise, far below any real cost.
  // The measured figure is printed for the PR record.
  it("stays within 100 ns of an empty call", () => {
    const iterations = 2_000_000;
    const empty = (_name: CrashPointName) => {};
    const time = (fn: (name: CrashPointName) => void) => {
      for (let i = 0; i < 100_000; i += 1) fn(first);
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i += 1) fn(i & 1 ? first : second);
      return Number(process.hrtime.bigint() - start) / iterations;
    };
    let baseline = Number.POSITIVE_INFINITY;
    let measured = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 7; round += 1) {
      baseline = Math.min(baseline, time(empty));
      measured = Math.min(measured, time(crashPoint));
    }
    console.info(`crashPoint disarmed: ${measured.toFixed(2)} ns/call (empty call ${baseline.toFixed(2)} ns)`);
    expect(measured).toBeLessThan(baseline + 100);
  });
});
