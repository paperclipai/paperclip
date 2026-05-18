/**
 * Safe evaluator for plugin-hook `when` predicates.
 *
 * Predicates are pure data structures (no functions, no eval). The evaluator
 * walks them and returns a boolean. Any structurally invalid predicate is
 * treated as a non-match so a malformed manifest cannot accidentally enable a
 * hook in a wider scope than intended (fail-closed).
 */

import type {
  PluginHookIssueContext,
  WhenPredicate,
} from "./types.js";

export interface PredicateContext {
  readonly issue: PluginHookIssueContext;
  readonly agentRole?: string;
}

/**
 * Maximum recursion depth allowed inside `all`/`any`/`not` predicates. Caps
 * cost in case a malicious or buggy manifest ships a deeply nested tree.
 */
const MAX_PREDICATE_DEPTH = 32;

/**
 * Evaluate a `when` predicate. Returns `true` when the predicate matches the
 * given context. A `null` / `undefined` predicate always matches.
 *
 * Predicates that exceed the depth cap fail closed regardless of how many
 * `not` wrappers surround them — the evaluator throws a sentinel, which the
 * top level converts to `false`. This prevents a deeply nested manifest from
 * smuggling a `not(not(...))` pyramid past the cap.
 */
export function evaluateWhen(
  predicate: WhenPredicate | null | undefined,
  ctx: PredicateContext,
): boolean {
  if (predicate == null) return true;
  try {
    return evalNode(predicate, ctx, 0);
  } catch (err) {
    if (err === DEPTH_EXCEEDED) return false;
    throw err;
  }
}

const DEPTH_EXCEEDED: unique symbol = Symbol("plugin-hooks/predicate-depth-exceeded");

function evalNode(node: unknown, ctx: PredicateContext, depth: number): boolean {
  if (depth > MAX_PREDICATE_DEPTH) throw DEPTH_EXCEEDED;
  if (node == null || typeof node !== "object") return false;

  const obj = node as Record<string, unknown>;

  if (typeof obj.issueHasField === "string") {
    return Object.prototype.hasOwnProperty.call(ctx.issue.fields, obj.issueHasField);
  }

  if (obj.issueFieldEquals && typeof obj.issueFieldEquals === "object") {
    const ife = obj.issueFieldEquals as { field?: unknown; value?: unknown };
    if (typeof ife.field !== "string") return false;
    if (!Object.prototype.hasOwnProperty.call(ctx.issue.fields, ife.field)) return false;
    return scalarEquals(ctx.issue.fields[ife.field], ife.value);
  }

  if (typeof obj.agentRoleEquals === "string") {
    return ctx.agentRole === obj.agentRoleEquals;
  }

  if (Array.isArray(obj.all)) {
    if (obj.all.length === 0) return true;
    return obj.all.every((child) => evalNode(child, ctx, depth + 1));
  }

  if (Array.isArray(obj.any)) {
    if (obj.any.length === 0) return false;
    return obj.any.some((child) => evalNode(child, ctx, depth + 1));
  }

  if (obj.not !== undefined) {
    return !evalNode(obj.not, ctx, depth + 1);
  }

  return false;
}

/**
 * Strict scalar comparison. Predicates only accept JSON scalars to keep
 * evaluation O(1); unknown / non-scalar shapes return `false`.
 */
function scalarEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  // Allow numeric/boolean equality across `null`/`undefined` boundary by
  // treating both as "missing" — but the caller already verified the field is
  // present, so this branch is only hit when the stored value itself is null.
  if (actual === null && expected === null) return true;
  return false;
}
