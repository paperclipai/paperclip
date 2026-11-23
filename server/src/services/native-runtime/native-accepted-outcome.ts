import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import type { PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import type { ProviderFailure } from "@paperclipai/shared";
import { nativeAcceptedResultOutlivesProviderFailure } from "./native-provider-failure.js";

/** Saved beside the raw terminal, which stays unchanged because the result's integrity digest covers it. */
export const NATIVE_ACCEPTED_OUTCOME_KEY = "acceptedOutcome";
const SCHEMA = "paperclip.native-accepted-outcome.v1";
const CAUSE = "transient_provider_refusal_after_finish";

export interface NativeAcceptedOutcome {
  schema: typeof SCHEMA;
  cause: typeof CAUSE;
  runTerminalState: "succeeded";
  turnTerminalState: "completed";
  providerFailure: { provider: string; category: string };
}

const CLOSED_VALUE = /^[a-z0-9_.-]{1,64}$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

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

export function readNativeAcceptedOutcome(resultJson: unknown): NativeAcceptedOutcome | null {
  const value = record(record(resultJson)[NATIVE_ACCEPTED_OUTCOME_KEY]);
  if (value.schema !== SCHEMA || value.cause !== CAUSE || value.runTerminalState !== "succeeded" ||
      value.turnTerminalState !== "completed") return null;
  const failure = record(value.providerFailure);
  const closed = (field: unknown) => typeof field === "string" && CLOSED_VALUE.test(field) ? field : "unknown";
  return { schema: SCHEMA, cause: CAUSE, runTerminalState: "succeeded", turnTerminalState: "completed",
    providerFailure: { provider: closed(failure.provider), category: closed(failure.category) } };
}

export function applyNativeAcceptedOutcome<T extends Record<string, unknown> | PrpTerminalState>(
  outcome: NativeAcceptedOutcome | null, terminal: T,
): T {
  return outcome ? { ...terminal, runTerminalState: outcome.runTerminalState, turnTerminalState: outcome.turnTerminalState } : terminal;
}

export function nativeEffectiveTerminal<T extends Record<string, unknown> | PrpTerminalState>(resultJson: unknown, terminal: T): T {
  return applyNativeAcceptedOutcome(readNativeAcceptedOutcome(resultJson), terminal);
}

const ALIAS = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
type TerminalField = "runTerminalState" | "turnTerminalState";
const SETTLED: Record<TerminalField, string> = { runTerminalState: "succeeded", turnTerminalState: "completed" };

export function nativeEffectiveRunTerminalStateSqlText(resultJson: string, field: TerminalField = "runTerminalState"): string {
  if (!ALIAS.test(resultJson)) throw new Error("native_accepted_outcome_column_invalid");
  const outcome = `${resultJson}->'${NATIVE_ACCEPTED_OUTCOME_KEY}'`;
  return `(case when ${outcome}->>'schema' = '${SCHEMA}' and ${outcome}->>'cause' = '${CAUSE}'
    and ${outcome}->>'runTerminalState' = 'succeeded' and ${outcome}->>'turnTerminalState' = 'completed'
    then '${SETTLED[field]}' else ${resultJson}->'terminal'->>'${field}' end)`;
}

export function nativeEffectiveRunTerminalStateSql(resultJson: AnyColumn | SQL, field: TerminalField = "runTerminalState"): SQL<string> {
  const outcome = sql`${resultJson}->${NATIVE_ACCEPTED_OUTCOME_KEY}`;
  return sql<string>`(case when ${outcome}->>'schema' = ${SCHEMA} and ${outcome}->>'cause' = ${CAUSE}
    and ${outcome}->>'runTerminalState' = 'succeeded' and ${outcome}->>'turnTerminalState' = 'completed'
    then ${SETTLED[field]} else ${resultJson}->'terminal'->>${field} end)`;
}

/** A transient refusal came from the remote model service and the turn ended cleanly, so the warm process stays usable. */
export function nativeRetainsWarmSession(input: {
  terminal: { runTerminalState: string };
  acceptedOutcome: NativeAcceptedOutcome | null;
  continuationKind?: string;
}) {
  return (input.terminal.runTerminalState === "succeeded" || input.acceptedOutcome !== null)
    && input.continuationKind !== "case_handoff";
}
