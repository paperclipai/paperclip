import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../middleware/logger.js";

export const AGENT_DISPATCH_PASS_DEADLINE_MS = 60_000;

export type AgentDispatchPass<R, T> = {
  request: R;
  idle: T;
  merge(current: R, next: R): R;
  run(request: R, signal: AbortSignal): Promise<{ value: T; settle?: () => Promise<void> }>;
  track?(pass: Promise<unknown>): void;
};

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void };
type FollowUp = { request: unknown; spec: AgentDispatchPass<unknown, unknown>; done: Deferred<unknown> };
type AgentDispatchState = { followUp: FollowUp | null; startedAtMs: number; expire(): void };

const dispatchStates = new Map<string, AgentDispatchState>();
const dispatchingAgent = new AsyncLocalStorage<string>();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export function isAgentDispatchActive(agentId: string) {
  return dispatchStates.has(agentId);
}

export function outsideAgentDispatch<T>(fn: () => T): T {
  return dispatchingAgent.exit(fn);
}

export function dispatchForAgent<R, T>(agentId: string, spec: AgentDispatchPass<R, T>): Promise<T> {
  let state = dispatchStates.get(agentId);
  if (state && performance.now() - state.startedAtMs >= AGENT_DISPATCH_PASS_DEADLINE_MS) {
    state.expire();
    state = dispatchStates.get(agentId);
  }
  if (!state) return startPass(agentId, spec, spec.request);
  if (state.followUp) {
    state.followUp.request = spec.merge(state.followUp.request as R, spec.request);
    state.followUp.spec = spec as AgentDispatchPass<unknown, unknown>;
  } else {
    state.followUp = { request: spec.request, spec: spec as AgentDispatchPass<unknown, unknown>, done: deferred() };
  }
  if (dispatchingAgent.getStore() === agentId) return Promise.resolve(spec.idle);
  return state.followUp.done.promise as Promise<T>;
}

function startPass<R, T>(agentId: string, spec: AgentDispatchPass<R, T>, request: R): Promise<T> {
  const controller = new AbortController();
  const expired = deferred<void>();
  const state: AgentDispatchState = { followUp: null, startedAtMs: performance.now(), expire: () => expire() };
  dispatchStates.set(agentId, state);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (dispatchStates.get(agentId) === state) dispatchStates.delete(agentId);
    const next = state.followUp;
    state.followUp = null;
    if (next) startPass(agentId, next.spec, next.request).then(next.done.resolve, next.done.reject);
  };
  const expire = () => {
    if (released) return;
    clearTimeout(deadline);
    logger.warn({ agentId, deadlineMs: AGENT_DISPATCH_PASS_DEADLINE_MS },
      "queued-run dispatch pass passed its deadline; it stops claiming and the next pass may start");
    controller.abort();
    release();
    expired.resolve();
  };
  const deadline = setTimeout(expire, AGENT_DISPATCH_PASS_DEADLINE_MS);
  deadline.unref?.();
  const pass = dispatchingAgent.run(agentId, () => spec.run(request, controller.signal)).then(
    async ({ value, settle }) => {
      clearTimeout(deadline);
      release();
      if (settle) await outsideAgentDispatch(settle);
      return value;
    },
    (err: unknown) => {
      clearTimeout(deadline);
      release();
      throw err;
    },
  );
  spec.track?.(Promise.race([pass.then(() => undefined, () => undefined), expired.promise]));
  return pass;
}
