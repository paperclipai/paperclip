import { logger } from "./middleware/logger.js";

export type StartupTimelineMark = { step: string; atMs: number; durationMs: number };

/** Boot-to-ready milestones, measured from process start. One log line at
 * readiness (and one when the background recovery passes finish) names the
 * step that took the time, without an OpenTelemetry collector. */
export function createStartupTimeline(uptimeMs: () => number = () => process.uptime() * 1000) {
  const marks: StartupTimelineMark[] = [];
  return {
    mark(step: string) {
      const atMs = Math.round(uptimeMs());
      const previous = marks.at(-1)?.atMs ?? 0;
      marks.push({ step, atMs, durationMs: atMs - previous });
    },
    marks: () => marks.map(mark => ({ ...mark })),
    log(message: string) {
      logger.info({
        processUptimeMs: Math.round(uptimeMs()),
        startupSteps: Object.fromEntries(marks.map(mark => [mark.step, mark.durationMs])),
      }, message);
    },
  };
}

export const startupTimeline = createStartupTimeline();
