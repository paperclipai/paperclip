import { parse, evaluate, type ParseResult } from "cel-js";

const EVAL_TIMEOUT_MS = 100;

export interface CelContext {
  event: {
    type: string;
    timestamp: string;
  };
  issue: Record<string, unknown>;
  actor: {
    type: "user" | "agent";
    id: string;
  };
  workProduct?: Record<string, unknown>;
  comment?: Record<string, unknown>;
}

export interface CelEvalResult {
  success: boolean;
  value: unknown;
  error?: string;
}

/**
 * Validate that a CEL expression is syntactically correct.
 * Returns null if valid, or an error message if invalid.
 */
export function validateCelExpression(expression: string): string | null {
  const result: ParseResult = parse(expression);
  if (result.isSuccess) return null;
  return result.errors.join("; ");
}

/**
 * Evaluate a CEL expression against a context, with a timeout guard.
 * Returns a boolean result (truthy coercion) or an error.
 */
export function evaluateCelExpression(expression: string, context: CelContext): CelEvalResult {
  try {
    const parseResult = parse(expression);
    if (!parseResult.isSuccess) {
      return { success: false, value: false, error: `Parse error: ${parseResult.errors.join("; ")}` };
    }

    // Evaluate with timeout using a synchronous guard.
    // cel-js evaluate is synchronous so we set up a simple timer check.
    const start = Date.now();
    const result = evaluate(parseResult.cst, context as unknown as Record<string, unknown>);
    const elapsed = Date.now() - start;

    if (elapsed > EVAL_TIMEOUT_MS) {
      return { success: false, value: false, error: `Evaluation exceeded ${EVAL_TIMEOUT_MS}ms timeout (took ${elapsed}ms)` };
    }

    return { success: true, value: Boolean(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, value: false, error: `Evaluation error: ${message}` };
  }
}

/**
 * Build a CelContext from issue/event data for rule evaluation.
 */
export function buildCelContext(opts: {
  eventType: string;
  issue: Record<string, unknown>;
  actor: { type: "user" | "agent"; id: string };
  workProduct?: Record<string, unknown>;
  comment?: Record<string, unknown>;
}): CelContext {
  return {
    event: {
      type: opts.eventType,
      timestamp: new Date().toISOString(),
    },
    issue: opts.issue,
    actor: opts.actor,
    workProduct: opts.workProduct,
    comment: opts.comment,
  };
}
