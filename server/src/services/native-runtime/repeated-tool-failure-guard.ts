import { HttpError } from "../../errors.js";
import { nativeSha256 } from "./canonical.js";

/** Identical failures after which the exact call is no longer run. */
export const REPEATED_TOOL_FAILURE_LIMIT = 2;
const MAX_TRACKED_FAILURES = 64;
const MAX_RESPONSE_EXCERPT = 2_000;

type ToolCall = { tool: string; callId: string; arguments: unknown };
type Failure = {
  count: number;
  status: number;
  message: string;
  details?: unknown;
  /** Returned by the route as an `ok: false` response rather than refused before sending. */
  returned: boolean;
};

/**
 * Stops a model from resending the same rejected tool call. Some model hosts
 * drop optional arguments, so the model can believe it fixed a call that
 * arrives unchanged every time. Only failures that are certain to repeat for
 * identical arguments count: request validation (400/422) thrown before the
 * request is sent, schema errors, and a route's own 400/422 returned as an
 * `ok: false` response. Timeouts, rate limits, conflicts, server errors and
 * any change to the arguments pass through untouched.
 *
 * A route can reject a request because of the state it found, so a returned
 * rejection is forgotten as soon as a different call succeeds; a refusal made
 * before sending depends on the arguments alone and is remembered for the run.
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
        + `${receivedArguments(call.arguments)} ${prior.returned ? `The response each time was HTTP ${prior.status}: ` : "The error each time was: "}${prior.message} `
        + "Repeating it unchanged cannot succeed. Send it again only with the change that error asks for, or stop calling it and tell the user what blocked you.", prior.details);
    }
    let result: T;
    try {
      result = await execute();
    } catch (error) {
      const failure = thrownFailure(error);
      if (!failure) throw error;
      const count = this.#record(key, failure);
      if (count < REPEATED_TOOL_FAILURE_LIMIT) throw error;
      throw new HttpError(failure.status, `${failure.message} ${repeatedNote(count, call)}`, failure.details);
    }
    const failure = returnedFailure(result);
    if (!failure) {
      // Only a success can have changed the state a route checked. A transient
      // failure (5xx, 429, timeout) leaves every remembered rejection in place.
      if (!isFailedResponse(result)) {
        this.#failures.delete(key);
        this.#forgetReturnedFailures();
      }
      return result;
    }
    const count = this.#record(key, failure);
    if (count < REPEATED_TOOL_FAILURE_LIMIT) return result;
    const response = result as Record<string, unknown>;
    const guidance = typeof response.guidance === "string" ? `${response.guidance} ` : "";
    return { ...response, guidance: `${guidance}${repeatedNote(count, call)}` } as T;
  }

  #record(key: string, failure: Omit<Failure, "count">): number {
    const latest = this.#failures.get(key);
    const count = latest && latest.message === failure.message && latest.status === failure.status ? latest.count + 1 : 1;
    this.#failures.delete(key);
    this.#failures.set(key, { ...failure, count });
    if (this.#failures.size > MAX_TRACKED_FAILURES) this.#failures.delete(this.#failures.keys().next().value!);
    return count;
  }

  #forgetReturnedFailures() {
    for (const [key, failure] of this.#failures) if (failure.returned) this.#failures.delete(key);
  }
}

function callKey(call: ToolCall): string {
  return nativeSha256({ tool: call.tool, arguments: call.arguments ?? null });
}

function isFailedResponse(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as Record<string, unknown>).ok === false);
}

function isValidationStatus(status: unknown): status is 400 | 422 {
  return status === 400 || status === 422;
}

function thrownFailure(error: unknown): Omit<Failure, "count"> | null {
  if (error instanceof HttpError && isValidationStatus(error.status)) {
    return { status: error.status, message: error.message, details: error.details, returned: false };
  }
  if (error instanceof Error && error.name === "ZodError") return { status: 400, message: error.message, returned: false };
  return null;
}

/** A route's validation rejection, returned as data (call_api's `ok: false` with HTTP 400/422). */
function returnedFailure(result: unknown): Omit<Failure, "count"> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const response = result as Record<string, unknown>;
  if (response.ok !== false || !isValidationStatus(response.status)) return null;
  const reason = response.data ?? response.message ?? response.error ?? null;
  const text = typeof reason === "string" ? reason : JSON.stringify(reason);
  return { status: response.status, message: text.length > MAX_RESPONSE_EXCERPT ? `${text.slice(0, MAX_RESPONSE_EXCERPT)}…` : text, returned: true };
}

function repeatedNote(count: number, call: ToolCall): string {
  return `This exact call has now failed ${count} times with the same arguments. ${receivedArguments(call.arguments)} `
    + "If you meant to send another argument, it did not arrive; send it as a top-level argument exactly as described above. "
    + "Paperclip will not run this exact call again in this run. Change the arguments, or stop and tell the user what blocked you.";
}

function receivedArguments(value: unknown): string {
  const names = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  return `Arguments received each time: ${names.length ? names.join(", ") : "none"}.`;
}
