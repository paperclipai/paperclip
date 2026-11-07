import { performance } from "node:perf_hooks";
import {
  isAdapterExecutionPhase,
  type AdapterExecutionPhase,
} from "@paperclipai/adapter-utils/execution-phase";

export const MAX_EXECUTION_PHASE_ELAPSED_MS = 86_400_000;
const MAX_ACTIVE_PHASES = 16;

/** Owned by one executor, never looked up by agent, task, or provider identity. */
export function createAdapterExecutionPhaseTracker(now = () => performance.now()) {
  const scopes = new Map<symbol, { phase: AdapterExecutionPhase; startedAt: number }>();
  let finished = false;
  let overflow = false;
  return {
    enter(phase: AdapterExecutionPhase) {
      if (finished || !isAdapterExecutionPhase(phase)) return;
      if (scopes.size >= MAX_ACTIVE_PHASES) {
        // Refuse further attribution rather than retain an unbounded history or
        // describe an older scope as the current one. finish clears the tracker.
        overflow = true;
        return;
      }
      const token = Symbol();
      let startedAt: number;
      try { startedAt = now(); } catch { return; }
      scopes.set(token, { phase, startedAt });
      return () => { scopes.delete(token); };
    },
    snapshot() {
      if (finished || overflow) return null;
      const current = [...scopes.values()].at(-1);
      if (!current) return null;
      let elapsed: number;
      try { elapsed = now() - current.startedAt; } catch { return null; }
      if (!Number.isFinite(elapsed) || elapsed < 0) return null;
      return { phase: current.phase, phaseElapsedMs: Math.min(Math.floor(elapsed), MAX_EXECUTION_PHASE_ELAPSED_MS) };
    },
    finish() {
      finished = true;
      scopes.clear();
    },
  };
}
