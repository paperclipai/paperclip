import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { FakePaperclip, VirtualClock, type FakeConfig } from "./fake-paperclip.ts";
import type { MainDeps } from "./main.ts";
import type { RampResult } from "./report.ts";

export const TOKEN = "board-token-SECRET-4f2a9c";
export const PROVIDER_KEY = "sk-or-v1-SECRET-provider-key-77";
export const METRICS_TOKEN = "metrics-token-SECRET-91";
export const HOST = "scale1.test.paperclip.app";
export const ORIGIN = `https://${HOST}`;
export const METRICS_URL = "https://metrics.scale1.test/metrics";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "scale-ramp-test-"));
  dirs.push(dir);
  return dir;
}

export interface Harness {
  clock: VirtualClock;
  fake: FakePaperclip;
  out: string[];
  err: string[];
  deps: MainDeps;
  fetchCalls: () => number;
  interrupt: () => void;
}

export function harness(config: Partial<FakeConfig> = {}, env: Record<string, string> = {}, answer = HOST): Harness {
  const clock = new VirtualClock();
  const fake = new FakePaperclip(clock, { token: TOKEN, origin: ORIGIN, ...config });
  const out: string[] = [];
  const err: string[] = [];
  let calls = 0;
  let handler: (() => void) | null = null;
  const deps: MainDeps = {
    env: { PAPERCLIP_SCALE_TOKEN: TOKEN, OPENROUTER_API_KEY: PROVIDER_KEY, ...env },
    fetcher: async (url, init) => {
      calls += 1;
      return fake.fetch(url, init);
    },
    clock,
    out: line => out.push(line),
    err: line => err.push(line),
    confirm: async () => answer,
    onInterrupt: fn => {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    random: () => 0.5,
  };
  return { clock, fake, out, err, deps, fetchCalls: () => calls, interrupt: () => handler?.() };
}

export const baseArgs = (out: string, extra: string[] = []) => [
  "--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--label", "scale-test-run", "--yes",
  "--hold-minutes", "2", "--drain-minutes", "3", "--poll-seconds", "15", "--board-probe-seconds", "10", "--task-minutes", "1", ...extra,
];

export async function readResult(out: string): Promise<RampResult> {
  return JSON.parse(await readFile(path.join(out, "scale-test-run", "result.json"), "utf8")) as RampResult;
}

export function assertCleanedUp(fake: FakePaperclip): void {
  assert.equal(fake.liveRuns().length, 0, "no queued or running run is left");
  assert.equal(fake.agents.size, 0, "every harness agent is deleted");
  assert.ok([...fake.issues.values()].every(issue => issue.hiddenAt), "every task is archived");
  assert.equal(fake.secrets.size, 0, "the stored provider secret is deleted");
  assert.ok([...fake.projects.values()].every(project => project.archivedAt), "the project is archived");
}

export const goodMetrics = (running: number) => ({
  eventLoopUtilization: 0.2 + running / 1_000, mainThreadCpu: 0.25, eventLoopDelayP99Ms: 20, statementsPerSecond: 40 * running,
  poolWaitP99Ms: 2, runEventLatenessP99Ms: 120, agentApiPreHandlerP99Ms: 15, leaseRenewalsMissed: 0,
});
