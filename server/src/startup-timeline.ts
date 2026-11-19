import { logger } from "./middleware/logger.js";

export type StartupTimelineMark = { step: string; atMs: number; durationMs: number };

/** A startup step still running after this long is named in a warning, so a
 * slow start says which step holds it in one grep ("startup step"). */
export const STARTUP_STEP_WARN_AFTER_MS = 30_000;

type StartupTimelineLogger = Pick<typeof logger, "info" | "warn" | "error">;

/** Boot-to-ready milestones, measured from process start. One log line at
 * readiness (and one when the background recovery passes finish) names the
 * step that took the time, without an OpenTelemetry collector.
 *
 * Readiness means "this server can serve requests and take over". Only
 * `precondition` steps hold it, and each one must be bounded by this boot, not
 * by saved backlog or an outside service. Work that grows with backlog (a
 * queue's first pass) goes through `background`: it starts at once, never
 * holds readiness, and is reported at readiness as still outstanding. */
export function createStartupTimeline(options: {
  uptimeMs?: () => number;
  log?: StartupTimelineLogger;
  warnAfterMs?: number;
} = {}) {
  const uptimeMs = options.uptimeMs ?? (() => process.uptime() * 1000);
  const log = options.log ?? logger;
  const warnAfterMs = options.warnAfterMs ?? STARTUP_STEP_WARN_AFTER_MS;
  const marks: StartupTimelineMark[] = [];
  const preconditions = new Map<string, number>();
  const background = new Map<string, number>();
  const outstanding = new Map<string, { startedAt: number; holdsReadiness: boolean }>();
  const now = () => Math.round(uptimeMs());

  function watch(step: string, holdsReadiness: boolean) {
    const startedAt = now();
    outstanding.set(step, { startedAt, holdsReadiness });
    // A step that holds readiness is named every period until it ends; a
    // background step is named once, since it does not delay anything. One
    // unref'd timeout at a time: no interval outlives the step.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => {
        if (!outstanding.has(step)) return;
        log.warn({ startupStep: step, waitingMs: now() - startedAt, holdsReadiness },
          holdsReadiness ? "startup step is still holding readiness" : "startup step is still running in the background");
        if (holdsReadiness) arm();
      }, warnAfterMs);
      timer.unref?.();
    };
    arm();
    return () => {
      clearTimeout(timer);
      outstanding.delete(step);
      return now() - startedAt;
    };
  }

  return {
    mark(step: string) {
      const atMs = now();
      const previous = marks.at(-1)?.atMs ?? 0;
      marks.push({ step, atMs, durationMs: atMs - previous });
    },
    marks: () => marks.map(mark => ({ ...mark })),
    /** A step readiness must wait for. Keep it bounded by this boot. */
    async precondition<T>(step: string, work: () => Promise<T>): Promise<T> {
      const finish = watch(step, true);
      try {
        return await work();
      } finally {
        preconditions.set(step, finish());
      }
    },
    /** Starts work that must not hold readiness. The returned promise never
     * rejects (a failure is logged with the step's name), so callers can track
     * it as scheduler work. */
    background(step: string, work: () => Promise<unknown>): Promise<void> {
      const finish = watch(step, false);
      return Promise.resolve().then(work).then(() => undefined, (err: unknown) => {
        log.error({ err, startupStep: step }, "startup background step failed");
      }).finally(() => {
        const durationMs = finish();
        background.set(step, durationMs);
        if (durationMs >= warnAfterMs) log.info({ startupStep: step, durationMs }, "startup background step finished");
      });
    },
    log(message: string) {
      log.info({
        processUptimeMs: now(),
        startupSteps: Object.fromEntries(marks.map(mark => [mark.step, mark.durationMs])),
        readinessStepsMs: Object.fromEntries(preconditions),
        backgroundStepsMs: Object.fromEntries(background),
        backgroundStepsOutstanding: [...outstanding].filter(([, entry]) => !entry.holdsReadiness).map(([step]) => step),
      }, message);
    },
  };
}

export const startupTimeline = createStartupTimeline();
