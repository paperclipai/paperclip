import { HttpError } from "../../errors.js";
import { nativeSha256 } from "./canonical.js";

/** Identical failures after which the exact call is no longer run. */
export const REPEATED_TOOL_FAILURE_LIMIT = 2;
const MAX_TRACKED_FAILURES = 64;

type ToolCall = { tool: string; callId: string; arguments: unknown };
type Failure = { count: number; status: number; message: string; details?: unknown };

/**
 * Stops a model from resending the same rejected tool call. Some model hosts
 * drop optional arguments, so the model can believe it fixed a call that
 * arrives unchanged every time. Only failures that are certain to repeat for
 * identical arguments count: request validation (400/422) and schema errors.
 * Other failures, and any change to the arguments, pass through untouched.
 *
 * State lives for one run's tool authority, in memory, and is bounded.
 */
export class RepeatedToolFailureGuard {
  readonly #failures = new Map<string, Failure>();
  // Identical calls a model sends in parallel run one after another, so each
  // sees the failures before it. Different calls never wait on each other.
  readonly #inFlight = new Map<string, Promise<unknown>>();

  run<T>(call: ToolCall, execute: () => Promise<T>): Promise<T> {
    const key = callKey(call);
    const previous = this.#inFlight.get(key);
    const current = previous ? previous.then(() => this.#run(key, call, execute), () => this.#run(key, call, execute)) : this.#run(key, call, execute);
    const settled = current.then(() => undefined, () => undefined);
    this.#inFlight.set(key, settled);
    void settled.then(() => { if (this.#inFlight.get(key) === settled) this.#inFlight.delete(key); });
    return current;
  }

  async #run<T>(key: string, call: ToolCall, execute: () => Promise<T>): Promise<T> {
    const prior = this.#failures.get(key);
    if (prior && prior.count >= REPEATED_TOOL_FAILURE_LIMIT) {
      throw new HttpError(prior.status, `This call was not run: ${call.tool} already failed ${prior.count} times in this run with these exact arguments. `
        + `${receivedArguments(call.arguments)} The error each time was: ${prior.message} `
        + "Repeating it unchanged cannot succeed. Send it again only with the change that error asks for, or stop calling it and tell the user what blocked you.", prior.details);
    }
    try {
      const result = await execute();
      this.#failures.delete(key);
      return result;
    } catch (error) {
      const failure = deterministicFailure(error);
      if (!failure) throw error;
      const latest = this.#failures.get(key);
      const count = latest && latest.message === failure.message && latest.status === failure.status ? latest.count + 1 : 1;
      this.#remember(key, { ...failure, count });
      if (count < REPEATED_TOOL_FAILURE_LIMIT) throw error;
      throw new HttpError(failure.status, `${failure.message} This exact call has now failed ${count} times with the same arguments. `
        + `${receivedArguments(call.arguments)} If you meant to send another argument, it did not arrive; send it as a top-level argument exactly as described above. `
        + "Paperclip will not run this exact call again in this run. Change the arguments, or stop and tell the user what blocked you.", failure.details);
    }
  }

  #remember(key: string, failure: Failure) {
    this.#failures.delete(key);
    this.#failures.set(key, failure);
    if (this.#failures.size > MAX_TRACKED_FAILURES) this.#failures.delete(this.#failures.keys().next().value!);
  }
}

function callKey(call: ToolCall): string {
  return nativeSha256({ tool: call.tool, arguments: call.arguments ?? null });
}

function deterministicFailure(error: unknown): Omit<Failure, "count"> | null {
  if (error instanceof HttpError && (error.status === 400 || error.status === 422)) {
    return { status: error.status, message: error.message, details: error.details };
  }
  if (error instanceof Error && error.name === "ZodError") return { status: 400, message: error.message };
  return null;
}

function receivedArguments(value: unknown): string {
  const names = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  return `Arguments received each time: ${names.length ? names.join(", ") : "none"}.`;
}
