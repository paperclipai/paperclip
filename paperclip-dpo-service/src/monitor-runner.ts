import type { Monitor, ClassifierStatus } from "./monitor.js";
import type { AuditTailer } from "./audit-tail.js";

export interface MonitorRunnerOptions {
  tailer: Pick<AuditTailer, "poll">;
  classifierProbe: () => Promise<ClassifierStatus>;
  monitor: Pick<Monitor, "evaluate" | "recordClassifierStatus">;
  intervalMs?: number;
}

export function startMonitorRunner(opts: MonitorRunnerOptions): () => void {
  const interval = opts.intervalMs ?? 5 * 60_000;
  const tick = async () => {
    try {
      opts.monitor.evaluate(opts.tailer.poll());
      opts.monitor.recordClassifierStatus(await opts.classifierProbe());
    } catch {
      // never let runner errors kill the service
    }
  };
  const t = setInterval(tick, interval);
  return () => clearInterval(t);
}
