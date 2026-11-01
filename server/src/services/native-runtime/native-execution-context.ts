import { randomUUID } from "node:crypto";
import type { PluginEnvironmentTaskExecutionContext } from "@paperclipai/plugin-sdk";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

export class NativeExecutionContext {
  readonly id = randomUUID();
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  readonly execution: NativeExecutionInput;
  #abort = new AbortController();
  #timer: ReturnType<typeof setTimeout>;
  #calls = new Set<object>();
  #waiters = new Set<() => void>();
  #finishWaiters = new Set<() => void>();
  #transport?: Promise<PluginEnvironmentTaskExecutionContext["transport"]>;
  #target?: string;
  #finished = false;
  pluginSupported = false;

  constructor(execution: NativeExecutionInput, timeoutMs: number) {
    this.execution = execution;
    this.deadlineAtMs = Date.now() + timeoutMs;
    this.signal = this.#abort.signal;
    this.#timer = setTimeout(() => this.abort(new Error("native_execution_startup_expired")), timeoutMs);
    this.#timer.unref?.();
  }

  get active(): boolean { return !this.#finished; }
  get pending(): boolean { return this.#calls.size > 0; }

  assertOpen(): void {
    if (this.#finished) throw new Error("native_execution_startup_completed");
    if (Date.now() >= this.deadlineAtMs) this.abort(new Error("native_execution_startup_expired"));
    this.signal.throwIfAborted();
  }

  assertScope(scope: { companyId: string; agentId: string; runId: string }): void {
    const binding = this.execution.binding;
    if (scope.companyId !== binding.companyId || scope.agentId !== binding.agentId || scope.runId !== binding.runId) {
      throw new Error("native_execution_context_scope_mismatch");
    }
    this.assertOpen();
  }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    let remove = () => {};
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => { this.assertOpen(); return operation(); }),
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(this.signal.reason);
          const finish = () => reject(new Error("native_execution_startup_completed"));
          this.#finishWaiters.add(finish);
          this.signal.addEventListener("abort", abort, { once: true });
          remove = () => {
            this.signal.removeEventListener("abort", abort);
            this.#finishWaiters.delete(finish);
          };
        }),
      ]);
      this.assertOpen();
      return value;
    } finally { remove(); }
  }

  async projection(target: { pluginId: string; leaseId: string; taskId: string; environmentId: string },
    resolve: () => Promise<PluginEnvironmentTaskExecutionContext["transport"]>): Promise<PluginEnvironmentTaskExecutionContext> {
    this.assertOpen();
    const key = JSON.stringify([target.pluginId, target.leaseId, target.taskId, target.environmentId]);
    if (this.#target !== undefined && this.#target !== key) throw new Error("native_execution_context_target_changed");
    this.#target = key;
    this.#transport ??= resolve();
    const transport = await this.wait(() => this.#transport!);
    this.assertOpen();
    return { id: this.id, deadlineAtMs: this.deadlineAtMs, transport };
  }

  trackWorker(): () => void {
    this.assertOpen();
    const call = {};
    this.#calls.add(call);
    return () => {
      this.#calls.delete(call);
      if (!this.#calls.size) for (const waiter of this.#waiters) waiter();
    };
  }

  async drain(): Promise<boolean> {
    if (!this.pending) return true;
    let timer: ReturnType<typeof setTimeout> | undefined, complete!: () => void;
    try {
      await Promise.race([
        new Promise<void>(resolve => { complete = resolve; this.#waiters.add(complete); }),
        new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, this.deadlineAtMs - Date.now())); }),
      ]);
      return !this.pending;
    } finally { clearTimeout(timer); this.#waiters.delete(complete); }
  }

  abort(reason: Error): void { this.#abort.abort(reason); }

  finish(): void {
    clearTimeout(this.#timer);
    this.#finished = true;
    this.#transport = undefined;
    for (const finish of this.#finishWaiters) finish();
    this.#finishWaiters.clear();
  }
}
