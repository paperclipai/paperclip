import { createHash } from "node:crypto";
import { semanticCanonicalJson } from "./semantic-tool-receipt.js";

/** Identical rejections after which the guard tells the model to stop. */
export const REPEATED_TOOL_INPUT_REJECTION_LIMIT = 2;
const MAX_TRACKED_REJECTIONS = 64;
const MAX_LISTED = 24;

type Rejection = { count: number; error: string };
type Schema = { properties?: unknown; required?: unknown };

/**
 * Runner-side counterpart of the control plane's repeated tool failure guard.
 * A tool call the runner rejects as invalid input never reaches the control
 * plane, so its guard cannot see it. Some model hosts drop arguments, so a
 * model can resend the same rejected call many times while believing it fixed
 * it. The second identical rejection adds what arrived and the expected
 * properties; the third and later say the call will not be accepted and the
 * model must change the arguments or stop and report the blocker.
 *
 * Identity is the tool name, the canonical arguments and the rejection text.
 * State lives for one bridge, in memory, and is bounded.
 */
export class RepeatedToolInputRejectionGuard {
  readonly #rejections = new Map<string, Rejection>();

  /** `scope` separates sessions that share one bridge. */
  reject(input: { scope?: string; tool: string; args: unknown; error: string; schema?: unknown }): string {
    const { tool, args, error, schema } = input;
    const key = rejectionKey(input.scope ?? "", tool, args);
    const prior = this.#rejections.get(key);
    const count = prior && prior.error === error ? prior.count + 1 : 1;
    this.#rejections.delete(key);
    this.#rejections.set(key, { count, error });
    if (this.#rejections.size > MAX_TRACKED_REJECTIONS) this.#rejections.delete(this.#rejections.keys().next().value!);
    if (count < REPEATED_TOOL_INPUT_REJECTION_LIMIT) return error;
    const expected = expectedProperties(schema);
    if (count === REPEATED_TOOL_INPUT_REJECTION_LIMIT) {
      return `${error} This exact call has now been rejected ${count} times with the same arguments. ${receivedArguments(args)}${expected ? ` ${expected}` : ""} `
        + `If you meant to send other arguments, they did not arrive: send every field as a top-level argument of ${tool} in one call. `
        + "An identical call will not be accepted again in this run. Change the arguments, or stop and tell the user what blocked you.";
    }
    return `This call was not accepted: ${tool} was already rejected ${count - 1} times in this run with these exact arguments. ${receivedArguments(args)}${expected ? ` ${expected}` : ""} `
      + `The error each time was: ${error} Repeating it unchanged cannot succeed. Stop calling ${tool} with these arguments: change them, or stop and tell the user what blocked you.`;
  }
}

function rejectionKey(scope: string, tool: string, args: unknown): string {
  let canonical: string;
  try { canonical = semanticCanonicalJson(args ?? null); } catch { canonical = String(args); }
  return createHash("sha256").update(scope).update("\0").update(tool).update("\0").update(canonical).digest("hex");
}

function names(keys: readonly string[]): string {
  return keys.length > MAX_LISTED ? `${keys.slice(0, MAX_LISTED).join(", ")}, and ${keys.length - MAX_LISTED} more` : keys.join(", ");
}

function receivedArguments(args: unknown): string {
  const keys = typeof args === "object" && args !== null && !Array.isArray(args) ? Object.keys(args).sort() : [];
  return `Arguments received each time: ${keys.length ? names(keys) : "none"}.`;
}

/** Lists the tool's top-level properties, so a model whose host hid them can still see them. */
export function expectedProperties(schema: unknown): string {
  const root = typeof schema === "object" && schema !== null ? schema as Schema : {};
  const properties = typeof root.properties === "object" && root.properties !== null ? Object.keys(root.properties) : [];
  if (properties.length === 0) return "";
  const required = Array.isArray(root.required) ? root.required.filter((key): key is string => typeof key === "string" && properties.includes(key)) : [];
  const optional = properties.filter(key => !required.includes(key));
  return `Expected properties: ${required.length ? `required ${names(required)}` : "none required"}${optional.length ? `; optional ${names(optional)}` : ""}.`;
}
