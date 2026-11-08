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

  it("restores the previous state on disarm", () => {
    const off = armCrashPointForTest(first);
    off();
    expect(armedCrashPoint()).toBeNull();
  });
});

describe("crashPoint armed by the environment", () => {
  const script = (name: string) => [
    `const { crashPoint } = await import(${JSON.stringify(path.join(import.meta.dirname, "crash-points.ts"))});`,
    `crashPoint(${JSON.stringify(name)}); process.stdout.write("one\\n");`,
    `crashPoint(${JSON.stringify(name)}); process.stdout.write("two\\n");`,
  ].join("\n");
  // The loader, not the tsx CLI: the CLI runs the script in a child process, so
  // the SIGKILL would land on a grandchild.
  const tsxLoader = pathToFileURL(path.resolve(import.meta.dirname, "../../../cli/node_modules/tsx/dist/loader.mjs")).href;
  const runChild = (env: Record<string, string>) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crash-point-script-"));
    try {
      const file = path.join(dir, "child.mts");
      writeFileSync(file, script(first));
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
  // about as much as an empty call. The bound is loose so CI noise cannot trip
  // it; the measured figure is printed for the PR record.
  it("stays within a few nanoseconds of an empty call", () => {
    const iterations = 5_000_000;
    const empty = (_name: CrashPointName) => {};
    const time = (fn: (name: CrashPointName) => void) => {
      for (let i = 0; i < 100_000; i += 1) fn(first);
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i += 1) fn(i & 1 ? first : second);
      return Number(process.hrtime.bigint() - start) / iterations;
    };
    const baseline = Math.min(time(empty), time(empty), time(empty));
    const measured = Math.min(time(crashPoint), time(crashPoint), time(crashPoint));
    console.info(`crashPoint disarmed: ${measured.toFixed(2)} ns/call (empty call ${baseline.toFixed(2)} ns)`);
    expect(measured).toBeLessThan(baseline + 10);
  });
});
