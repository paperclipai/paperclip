import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import type { PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import type { ProviderFailure } from "@paperclipai/shared";
import { nativeAcceptedResultOutlivesProviderFailure } from "./native-provider-failure.js";

/**
 * The run outcome Paperclip decided when it accepted a result, saved beside the
 * provider's raw terminal in `native_run_results.result_json`. The raw terminal
 * stays unchanged: it is part of the accepted result's integrity digest.
 *
 * Only one outcome exists: the agent's done report was accepted and the only
 * later failure in that turn was a transient provider refusal. A row without
 * this field (every other result, and every row saved by an older release)
 * keeps the raw terminal as its outcome.
 */
export const NATIVE_ACCEPTED_OUTCOME_KEY = "acceptedOutcome";
const SCHEMA = "paperclip.native-accepted-outcome.v1";
const CAUSE = "transient_provider_refusal_after_finish";

export interface NativeAcceptedOutcome {
  schema: typeof SCHEMA;
  cause: typeof CAUSE;
  runTerminalState: "succeeded";
  turnTerminalState: "completed";
  /** Closed fields only: which provider refused, and how. Never provider text. */
  providerFailure: { provider: string; category: string };
}

const CLOSED_VALUE = /^[a-z0-9_.-]{1,64}$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Decide the accepted outcome from the committed terminal and its typed failure. */
export function deriveNativeAcceptedOutcome(input: {
  terminal: PrpTerminalState;
  providerFailure: { errorCode: string; diagnostic?: unknown } | null;
  providerExplanation: ProviderFailure | null;
}): NativeAcceptedOutcome | null {
  if (!nativeAcceptedResultOutlivesProviderFailure(input)) return null;
  const source = input.providerExplanation
    ? { provider: input.providerExplanation.provider, category: input.providerExplanation.category }
    : record(input.providerFailure?.diagnostic);
  const provider = typeof source.provider === "string" && CLOSED_VALUE.test(source.provider) ? source.provider : "unknown";
  const category = typeof source.category === "string" && CLOSED_VALUE.test(source.category) ? source.category : "unknown";
  return { schema: SCHEMA, cause: CAUSE, runTerminalState: "succeeded", turnTerminalState: "completed",
    providerFailure: { provider, category } };
}

/**
 * Read a saved accepted outcome. The schema, cause and states decide whether
 * it applies (as `nativeEffectiveRunTerminalStateSql` does); unexpected
 * provider or category values are reduced to "unknown".
 */
export function readNativeAcceptedOutcome(resultJson: unknown): NativeAcceptedOutcome | null {
  const value = record(record(resultJson)[NATIVE_ACCEPTED_OUTCOME_KEY]);
  if (value.schema !== SCHEMA || value.cause !== CAUSE || value.runTerminalState !== "succeeded" ||
      value.turnTerminalState !== "completed") return null;
  const failure = record(value.providerFailure);
  const closed = (field: unknown) => typeof field === "string" && CLOSED_VALUE.test(field) ? field : "unknown";
  return { schema: SCHEMA, cause: CAUSE, runTerminalState: "succeeded", turnTerminalState: "completed",
    providerFailure: { provider: closed(failure.provider), category: closed(failure.category) } };
}

/** The terminal a run settles with under an accepted outcome (or the raw one without). */
export function applyNativeAcceptedOutcome<T extends Record<string, unknown> | PrpTerminalState>(
  outcome: NativeAcceptedOutcome | null, terminal: T,
): T {
  return outcome ? { ...terminal, runTerminalState: outcome.runTerminalState, turnTerminalState: outcome.turnTerminalState } : terminal;
}

/** The terminal a saved result settles the run with. */
export function nativeEffectiveTerminal<T extends Record<string, unknown> | PrpTerminalState>(resultJson: unknown, terminal: T): T {
  return applyNativeAcceptedOutcome(readNativeAcceptedOutcome(resultJson), terminal);
}

/** SQL twin of `nativeEffectiveTerminal(...).runTerminalState` for a `native_run_results.result_json` column. */
export function nativeEffectiveRunTerminalStateSql(resultJson: AnyColumn | SQL): SQL<string> {
  const outcome = sql`${resultJson}->${NATIVE_ACCEPTED_OUTCOME_KEY}`;
  return sql<string>`case when ${outcome}->>'schema' = ${SCHEMA} and ${outcome}->>'cause' = ${CAUSE}
    and ${outcome}->>'runTerminalState' = 'succeeded' and ${outcome}->>'turnTerminalState' = 'completed'
    then 'succeeded' else ${resultJson}->'terminal'->>'runTerminalState' end`;
}
