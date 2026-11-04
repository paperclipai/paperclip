import os from "node:os";
import { HttpError } from "../errors.js";
import type { SecretSensitiveRouteFamily } from "./http-log-policy.js";

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const MAX_CAUSE_DEPTH = 4;
const MAX_ORIGIN_FRAMES = 8;
// Express route definitions are source code, not request data. Anything
// outside this character set (for example a RegExp route) is dropped.
const ROUTE_PATTERN = /^[A-Za-z0-9_/:.*?(){}-]{1,200}$/;
// PostgreSQL SQLSTATE: five upper-case alphanumerics with at least one digit.
const SQLSTATE_PATTERN = /^(?=.*\d)[0-9A-Z]{5}$/;
// One V8 frame whose function name and location contain only code-shaped
// characters. Frames that do not match are dropped, never truncated.
const STACK_FRAME_PATTERN =
  /^at (?:(?:async |new )?[A-Za-z0-9_$.<>[\]]{1,120} \((?:file:\/\/)?(?:node:)?[A-Za-z0-9_./@+-]{1,300}:\d{1,7}:\d{1,7}\)|(?:file:\/\/)?(?:node:)?[A-Za-z0-9_./@+-]{1,300}:\d{1,7}:\d{1,7})$/;

export type SecretSensitiveErrorKind =
  | "http_error"
  | "type_error"
  | "range_error"
  | "reference_error"
  | "syntax_error"
  | "error"
  | "non_error";

/**
 * Fixed-shape facts about a failed secret-sensitive request. Every value is a
 * closed label, a bounded number, or text taken from source code. None is
 * copied from the error message, error name, request URL, body, or headers.
 */
export interface SecretSensitiveRequestDiagnostics {
  routeFamily: SecretSensitiveRouteFamily;
  method: string;
  status: number;
  errorKind: SecretSensitiveErrorKind;
  errnoCode: string | null;
  databaseErrorCode: string | null;
  routePattern: string | null;
  originFrames: string[];
}

export interface SecretSensitiveRequestFacts {
  routeFamily: SecretSensitiveRouteFamily;
  method: string | undefined;
  /** The matched Express route definition, when the router recorded one. */
  routePath: unknown;
}

/**
 * The only error a credential-bearing route reports. It keeps the generic
 * message and its own stack, so Sentry grouping does not change, and adds
 * bounded diagnostics that say where the original failure came from.
 */
export class SecretSensitiveRequestError extends Error {
  readonly diagnostics: SecretSensitiveRequestDiagnostics;

  constructor(original: unknown, facts: SecretSensitiveRequestFacts) {
    super("Secret-sensitive request failed");
    // Both `name` and `message` are attacker/provider-controlled properties on
    // JavaScript errors. Do not preserve either on a credential-bearing route.
    this.name = "Error";
    this.diagnostics = Object.freeze({
      routeFamily: facts.routeFamily,
      method: normalizeMethod(facts.method),
      status: original instanceof HttpError && isServerErrorStatus(original.status) ? original.status : 500,
      errorKind: errorKindOf(original),
      errnoCode: findOwnCode(original, (code) => Object.hasOwn(os.constants.errno, code)),
      databaseErrorCode: findOwnCode(original, (code) => SQLSTATE_PATTERN.test(code)),
      routePattern: normalizeRoutePattern(facts.routePath),
      originFrames: originFramesOf(original),
    });
  }
}

function normalizeMethod(method: string | undefined): string {
  const upper = typeof method === "string" ? method.toUpperCase() : "";
  return HTTP_METHODS.has(upper) ? upper : "other";
}

function isServerErrorStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 500 && status <= 599;
}

function errorKindOf(error: unknown): SecretSensitiveErrorKind {
  if (error instanceof HttpError) return "http_error";
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof ReferenceError) return "reference_error";
  if (error instanceof SyntaxError) return "syntax_error";
  return error instanceof Error ? "error" : "non_error";
}

/** Read `code` from the error and its causes as own data properties only. */
function findOwnCode(error: unknown, accept: (code: string) => boolean): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth++) {
    const code = Object.getOwnPropertyDescriptor(current, "code");
    if (code && "value" in code && typeof code.value === "string" && accept(code.value)) return code.value;
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    current = cause && "value" in cause ? cause.value : null;
  }
  return null;
}

function normalizeRoutePattern(routePath: unknown): string | null {
  return typeof routePath === "string" && ROUTE_PATTERN.test(routePath) ? routePath : null;
}

/**
 * Keep the original throw site without its message. The first stack line
 * repeats `name: message`, so only lines that are a well-formed frame survive.
 */
function originFramesOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  let stack: unknown;
  try {
    // V8 exposes `stack` as an accessor; a replaced getter must not break reporting.
    stack = error.stack;
  } catch {
    return [];
  }
  if (typeof stack !== "string") return [];
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const frame = line.trim();
    if (!STACK_FRAME_PATTERN.test(frame)) continue;
    frames.push(frame);
    if (frames.length === MAX_ORIGIN_FRAMES) break;
  }
  return frames;
}
