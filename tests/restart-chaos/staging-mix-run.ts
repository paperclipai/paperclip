import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentRunCaps, type StagingMixOptions } from "./staging-mix.js";
import type { AdapterId, TaskPlan, WaveOptions } from "./types.js";

export const RESOURCE_SAMPLE_MS = 30_000;

export interface ProcessRow { pid: number; ppid: number; rssKb: number; cpu: number }
export interface ResourceSample { at: number; descendants: number; rssMb: number; cpuPercent: number; availableMb: number; load1m: number; inFlight: number }

export function parsePs(output: string): ProcessRow[] {
  return output.split("\n").flatMap(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return [];
    const [pid, ppid, rss, cpu] = parts.map(Number);
    return [pid, ppid, rss, cpu].every(Number.isFinite) ? [{ pid: pid!, ppid: ppid!, rssKb: rss!, cpu: cpu! }] : [];
  });
}

export function descendantsOf(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const out: ProcessRow[] = [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) { out.push(child); queue.push(child.pid); }
  }
  return out;
}

export function parseVmStat(output: string): number | null {
  const pageSize = Number(/page size of ([0-9]+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize)) return null;
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+([0-9]+)`).exec(output)?.[1] ?? 0);
  return Math.round(((pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * pageSize) / 1_048_576);
}

export function parseMemInfo(output: string): number | null {
  const kb = /^MemAvailable:\s+([0-9]+) kB$/m.exec(output)?.[1];
  return kb === undefined ? null : Math.round(Number(kb) / 1024);
}

export function availableMemoryMb(platform: NodeJS.Platform = process.platform): number {
  try {
    const parsed = platform === "darwin" ? parseVmStat(execFileSync("vm_stat", { encoding: "utf8" }))
      : platform === "linux" ? parseMemInfo(readFileSync("/proc/meminfo", "utf8")) : null;
    if (parsed !== null) return parsed;
  } catch {
    return Math.round(os.freemem() / 1_048_576);
  }
  return Math.round(os.freemem() / 1_048_576);
}

export function sampleResources(root: number, inFlight: number, now = Date.now()): ResourceSample {
  let rows: ProcessRow[] = [];
  try { rows = descendantsOf(parsePs(execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,%cpu="], { encoding: "utf8" })), root); } catch { rows = []; }
  return { at: now, descendants: rows.length, rssMb: Math.round(rows.reduce((sum, row) => sum + row.rssKb, 0) / 1024),
    cpuPercent: Math.round(rows.reduce((sum, row) => sum + row.cpu, 0)), availableMb: availableMemoryMb(), load1m: Number(os.loadavg()[0]!.toFixed(2)), inFlight };
}

export function stagingMixSeedOptions(options: WaveOptions): { maxConcurrentRunsByAdapter?: Partial<Record<AdapterId, number>> } {
  return options.stagingMix ? { maxConcurrentRunsByAdapter: agentRunCaps(options.stagingMix.ratio, options.stagingMix.runs) } : {};
}

export function unfiredFaultSlots(tasks: readonly TaskPlan[], faults: ReadonlyArray<{ requestedBy: string }>): string[] {
  const fired = new Set(faults.map(fault => fault.requestedBy));
  return tasks.filter(task => task.stagingMix && task.fault !== "K0" && !fired.has(task.taskId)).map(task => `${task.taskId}:${task.fault}`);
}

export class StagingMixRun {
  readonly samples: ResourceSample[] = [];
  ended = false;
  private held = false;
  private timer: NodeJS.Timeout | null = null;
  inFlight = () => 0;

  constructor(readonly mix: StagingMixOptions, readonly startedAt: number, private readonly note: (kind: string, data: Record<string, unknown>) => void,
    private readonly waveDir: string, readonly minFreeMb = mix.minFreeMb,
    private readonly sample: (inFlight: number) => ResourceSample = inFlight => sampleResources(process.pid, inFlight)) {}

  start(): this {
    this.record();
    this.timer = setInterval(() => this.record(), RESOURCE_SAMPLE_MS);
    this.timer.unref();
    this.note("staging_mix_started", { runs: this.mix.runs, queue: this.mix.queue, minutes: this.mix.minutes, runCap: this.mix.runCap, minFreeMb: this.minFreeMb });
    return this;
  }

  record(): ResourceSample {
    const sample = this.sample(this.inFlight());
    this.samples.push(sample);
    this.note("staging_mix_resources", { ...sample });
    return sample;
  }

  endIfDue(now: number): boolean {
    if (this.ended || now < this.startedAt + this.mix.minutes * 60_000) return false;
    this.ended = true;
    this.note("staging_mix_arrivals_ended", { at: now });
    return true;
  }

  mayLaunch(now: number, next: TaskPlan): boolean {
    if (this.ended || !next.stagingMix || now < this.startedAt + next.stagingMix.arriveAtMs) return false;
    const latest = this.samples[this.samples.length - 1];
    const low = latest !== undefined && latest.availableMb < this.minFreeMb;
    if (low !== this.held) {
      this.held = low;
      this.note(low ? "staging_mix_launch_held" : "staging_mix_launch_resumed", { availableMb: latest?.availableMb ?? null, minFreeMb: this.minFreeMb });
    }
    return !low;
  }

  summary() {
    const peak = (key: "rssMb" | "cpuPercent" | "load1m" | "inFlight") => Math.max(0, ...this.samples.map(sample => sample[key]));
    return { samples: this.samples.length, peakRssMb: peak("rssMb"), peakCpuPercent: peak("cpuPercent"), peakLoad1m: peak("load1m"), peakInFlight: peak("inFlight"),
      minAvailableMb: Math.min(...this.samples.map(sample => sample.availableMb)), totalMemoryMb: Math.round(os.totalmem() / 1_048_576), cpus: os.cpus().length };
  }

  async stop(): Promise<void> {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.record();
    const summary = this.summary();
    this.note("staging_mix_resources_summary", summary);
    await writeFile(path.join(this.waveDir, "staging-mix-resources.json"), `${JSON.stringify({ summary, samples: this.samples }, null, 2)}\n`, { mode: 0o600 })
      .catch(error => this.note("staging_mix_resources_write_failed", { error: String(error) }));
  }
}
