import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginSpanRecord } from "./protocol.js";

// One bounded receipt per invocation; children never select their host parent.
export function createInvocationTracer(
  enabled: () => boolean,
  record: (span: PluginSpanRecord) => void,
) {
  type Scope = { span: PluginSpanRecord; budget: { remaining: number }; closed: boolean; clock: {epoch:number; origin:number} };
  const active = new AsyncLocalStorage<Scope>();
  async function withSpan<T>(name: string, work: () => T | Promise<T>, attributes?: Record<string, string | number | boolean>): Promise<T> {
    if (!enabled()) return work();
    const parent = active.getStore();
    // Detached work cannot outlive or inherit a completed invocation receipt.
    if (parent?.closed) return work();
    const budget = parent?.budget ?? { remaining: 256 };
    if (budget.remaining-- <= 0) return work();
    const clock = parent?.clock ?? {epoch:Date.now(), origin:performance.now()};
    const startTimeMs = clock.epoch + performance.now() - clock.origin;
    const span: PluginSpanRecord = { name, startTimeMs, attributes, children: [] };
    const scope: Scope = { span, budget, closed: false, clock };
    parent?.span.children?.push(span);
    try { return await active.run(scope, work); }
    catch (error) { span.status = { code: 2 }; throw error; }
    finally {
      scope.closed = true;
      span.endTimeMs = clock.epoch + performance.now() - clock.origin;
      if (!parent) { try { record(span); } catch {} }
    }
  }
  function appendSpan(scope:Scope | undefined, span:PluginSpanRecord):boolean {
    if (!scope) return false;
    if (!enabled() || scope.closed || scope.budget.remaining-- <= 0) return true;
    scope.span.children?.push(span);
    return true;
  }
  return {
    withSpan,
    clock: () => {
      const clock=active.getStore()?.clock ?? {epoch:Date.now(),origin:performance.now()};
      return () => clock.epoch+performance.now()-clock.origin;
    },
    now: () => { const clock=active.getStore()?.clock; return clock ? clock.epoch+performance.now()-clock.origin : Date.now(); },
    isRecording: enabled,
    recordSpan: (span:PluginSpanRecord) => appendSpan(active.getStore(),span),
    captureRecorder: () => {
      const scope=active.getStore();
      return (span:PluginSpanRecord) => appendSpan(scope,span);
    },
  };
}
