import { readFile } from "node:fs/promises";
import { PerformanceObserver, performance, type PerformanceEntry } from "node:perf_hooks";

// Records a long event-loop block as one local log line. Nothing leaves the
// process: this is neither the Telemetry nor the Observability path.
//
// A timer that should fire every `intervalMs` measures how late it ran. When it
// is late by `thresholdMs` or more, the line carries the process-level deltas
// that tell the usual causes apart:
// - main-thread CPU work (sync JSON, regex, hashing, compression): CPU ≈ stall
// - garbage collection: GC pause time ≈ stall
// - memory paging: many major page faults
// - host suspend: wall clock advanced far more than the monotonic clock
// - CPU throttling by the container: cgroup throttled time grows
// - sync file I/O or a sync child process: little CPU, none of the above
//
// The timer reads only process counters (and, every ten seconds, the cgroup's
// cpu.stat). It never queries the database or the network, so it does not keep
// an idle instance or its database awake; it is unref'd and stopped on shutdown.
export type EventLoopStallCause =
  | "gc"
  | "main_thread_cpu"
  | "memory_paging"
  | "host_suspended"
  | "cpu_throttled"
  | "blocked_off_cpu";

export type EventLoopStall = {
  stallMs: number;
  monotonicElapsedMs: number;
  wallElapsedMs: number;
  stallStartedAt: string;
  stallEndedAt: string;
  likelyCause: EventLoopStallCause;
  cpuUserMs: number;
  cpuSystemMs: number;
  gcPauseMs: number;
  gcCount: number;
  majorPageFaults: number;
  minorPageFaults: number;
  fsReads: number;
  fsWrites: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
  cgroupThrottledMs: number | null;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  processUptimeSec: number;
};

type ResourceSample = Pick<
  NodeJS.ResourceUsage,
  | "majorPageFault"
  | "minorPageFault"
  | "fsRead"
  | "fsWrite"
  | "voluntaryContextSwitches"
  | "involuntaryContextSwitches"
>;

export type EventLoopStallProbes = {
  monotonicNow: () => number;
  wallNow: () => number;
  cpuUsage: () => NodeJS.CpuUsage;
  resourceUsage: () => ResourceSample;
  memoryUsage: () => NodeJS.MemoryUsage;
  uptimeSec: () => number;
  // Total time this process's cgroup was CPU-throttled, in microseconds, or null.
  readCgroupThrottledUsec: () => Promise<number | null>;
};

export type EventLoopStallMonitorOptions = {
  log: (stall: EventLoopStall) => void;
  intervalMs?: number;
  thresholdMs?: number;
  probes?: Partial<EventLoopStallProbes>;
  // GC pause entries can be supplied by a test; by default a GC observer is used.
  gcEntries?: () => readonly Pick<PerformanceEntry, "startTime" | "duration">[];
};

export const EVENT_LOOP_STALL_INTERVAL_MS = 1_500;
export const EVENT_LOOP_STALL_THRESHOLD_MS = 2_000;
const CGROUP_SAMPLE_INTERVAL_MS = 10_000;
const MAX_GC_ENTRIES = 512;
const MAJOR_FAULTS_FOR_PAGING = 1_000;

async function readCgroupV2ThrottledUsec(): Promise<number | null> {
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile("/sys/fs/cgroup/cpu.stat", "utf8");
    const match = /^throttled_usec\s+(\d+)$/m.exec(stat);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const defaultProbes: EventLoopStallProbes = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  cpuUsage: () => process.cpuUsage(),
  resourceUsage: () => process.resourceUsage(),
  memoryUsage: () => process.memoryUsage(),
  uptimeSec: () => process.uptime(),
  readCgroupThrottledUsec: readCgroupV2ThrottledUsec,
};

export function classifyEventLoopStall(input: {
  stallMs: number;
  monotonicElapsedMs: number;
  wallElapsedMs: number;
  cpuMs: number;
  gcPauseMs: number;
  majorPageFaults: number;
  cgroupThrottledMs: number | null;
}): EventLoopStallCause {
  const half = input.stallMs / 2;
  if (input.wallElapsedMs - input.monotonicElapsedMs >= half) return "host_suspended";
  if (input.gcPauseMs >= half) return "gc";
  if (input.majorPageFaults >= MAJOR_FAULTS_FOR_PAGING) return "memory_paging";
  if (input.cgroupThrottledMs !== null && input.cgroupThrottledMs >= half) return "cpu_throttled";
  if (input.cpuMs >= half) return "main_thread_cpu";
  return "blocked_off_cpu";
}

export function startEventLoopStallMonitor(options: EventLoopStallMonitorOptions): { stop: () => void } {
  const probes = { ...defaultProbes, ...options.probes };
  const intervalMs = options.intervalMs ?? EVENT_LOOP_STALL_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? EVENT_LOOP_STALL_THRESHOLD_MS;

  let gcObserver: PerformanceObserver | null = null;
  const observedGc: Pick<PerformanceEntry, "startTime" | "duration">[] = [];
  let gcEntries = options.gcEntries;
  if (!gcEntries) {
    try {
      gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          observedGc.push({ startTime: entry.startTime, duration: entry.duration });
        }
        if (observedGc.length > MAX_GC_ENTRIES) observedGc.splice(0, observedGc.length - MAX_GC_ENTRIES);
      });
      gcObserver.observe({ entryTypes: ["gc"] });
    } catch {
      gcObserver = null;
    }
    gcEntries = () => observedGc;
  }

  let lastMonotonic = probes.monotonicNow();
  let lastWall = probes.wallNow();
  let lastCpu = probes.cpuUsage();
  let lastResources = probes.resourceUsage();
  let cgroupBaseline: number | null = null;
  let cgroupSampledAt = Number.NEGATIVE_INFINITY;
  let cgroupReading = false;
  let stopped = false;

  const sampleCgroup = () => {
    if (cgroupReading || stopped) return;
    cgroupReading = true;
    void probes.readCgroupThrottledUsec()
      .then((value) => { cgroupBaseline = value; })
      .catch(() => { cgroupBaseline = null; })
      .finally(() => { cgroupReading = false; });
  };

  const check = () => {
    const monotonic = probes.monotonicNow();
    const wall = probes.wallNow();
    const monotonicElapsedMs = monotonic - lastMonotonic;
    const wallElapsedMs = wall - lastWall;
    // A host suspend may stop the monotonic clock, so use the larger of the two.
    const stallMs = Math.max(monotonicElapsedMs, wallElapsedMs) - intervalMs;
    if (stallMs >= thresholdMs) {
      const cpu = probes.cpuUsage();
      const resources = probes.resourceUsage();
      const memory = probes.memoryUsage();
      const windowStart = lastMonotonic;
      let gcPauseMs = 0;
      let gcCount = 0;
      for (const entry of gcEntries!()) {
        if (entry.startTime + entry.duration < windowStart || entry.startTime > monotonic) continue;
        gcPauseMs += entry.duration;
        gcCount += 1;
      }
      const cpuUserMs = (cpu.user - lastCpu.user) / 1000;
      const cpuSystemMs = (cpu.system - lastCpu.system) / 1000;
      // Compute every delta now: the cgroup read below is asynchronous, and
      // later ticks replace the baselines before it settles.
      const previous = lastResources;
      const majorPageFaults = resources.majorPageFault - previous.majorPageFault;
      const minorPageFaults = resources.minorPageFault - previous.minorPageFault;
      const fsReads = resources.fsRead - previous.fsRead;
      const fsWrites = resources.fsWrite - previous.fsWrite;
      const voluntaryContextSwitches = resources.voluntaryContextSwitches - previous.voluntaryContextSwitches;
      const involuntaryContextSwitches = resources.involuntaryContextSwitches - previous.involuntaryContextSwitches;
      const uptimeSec = Math.round(probes.uptimeSec());
      const baseline = cgroupBaseline;
      const stallStartedAt = new Date(lastWall).toISOString();
      const stallEndedAt = new Date(wall).toISOString();
      const report = (cgroupThrottledMs: number | null) => {
        const rounded = Math.round(stallMs);
        options.log({
          stallMs: rounded,
          monotonicElapsedMs: Math.round(monotonicElapsedMs),
          wallElapsedMs: Math.round(wallElapsedMs),
          stallStartedAt,
          stallEndedAt,
          likelyCause: classifyEventLoopStall({
            stallMs: rounded,
            monotonicElapsedMs,
            wallElapsedMs,
            cpuMs: cpuUserMs + cpuSystemMs,
            gcPauseMs,
            majorPageFaults,
            cgroupThrottledMs,
          }),
          cpuUserMs: Math.round(cpuUserMs),
          cpuSystemMs: Math.round(cpuSystemMs),
          gcPauseMs: Math.round(gcPauseMs),
          gcCount,
          majorPageFaults,
          minorPageFaults,
          fsReads,
          fsWrites,
          voluntaryContextSwitches,
          involuntaryContextSwitches,
          cgroupThrottledMs,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
          processUptimeSec: uptimeSec,
        });
      };
      // Throttled time is read after the stall; the baseline is at most one
      // sampling interval older than the stall start, so the delta can include
      // a few seconds before it.
      if (baseline === null) {
        report(null);
      } else {
        void probes.readCgroupThrottledUsec()
          .then((after) => stopped ? undefined : report(after === null ? null : Math.round((after - baseline) / 1000)))
          .catch(() => report(null));
      }
      cgroupSampledAt = Number.NEGATIVE_INFINITY;
      lastCpu = cpu;
      lastResources = resources;
    } else {
      lastCpu = probes.cpuUsage();
      lastResources = probes.resourceUsage();
    }
    lastMonotonic = monotonic;
    lastWall = wall;
    if (monotonic - cgroupSampledAt >= CGROUP_SAMPLE_INTERVAL_MS) {
      cgroupSampledAt = monotonic;
      sampleCgroup();
    }
  };

  // One pending unref'd timeout, re-armed after each check. Server startup
  // creates no interval timers, and this probe is not a work scan.
  let timer: NodeJS.Timeout | null = null;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      check();
      arm();
    }, intervalMs);
    (timer as Partial<NodeJS.Timeout>).unref?.();
  };
  arm();
  sampleCgroup();
  cgroupSampledAt = lastMonotonic;

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      gcObserver?.disconnect();
    },
  };
}
