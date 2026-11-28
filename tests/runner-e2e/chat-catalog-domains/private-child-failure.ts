import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** A credential-bearing child keeps its stdout, stderr and error text private.
 * On failure it may record only which fixed step failed and the error's class,
 * so a CI failure is diagnosable without exposing any value. */
export const PRIVATE_CHILD_FAILURE_FILENAME = "failure.json";
const ERROR_CLASSES = ["TimeoutError", "AbortError", "TypeError", "SyntaxError", "RangeError", "Error"] as const;
type ErrorClass = typeof ERROR_CLASSES[number];
const STEP = /^[a-z][a-z0-9-]{0,63}$/;

export function privateChildErrorClass(error: unknown): ErrorClass {
  const name = error instanceof Error ? error.name : "";
  return (ERROR_CLASSES as readonly string[]).includes(name) ? name as ErrorClass : "Error";
}

/** Child side. `step` must be one of the caller's own constants. */
export async function recordPrivateChildFailure(directory: string, step: string, error: unknown) {
  try {
    await writeFile(path.join(directory, PRIVATE_CHILD_FAILURE_FILENAME),
      JSON.stringify({ step: STEP.test(step) ? step : "unknown", errorClass: privateChildErrorClass(error) }), { mode: 0o600, flag: "wx" });
  } catch { /* the parent still reports a withheld failure */ }
}

/** Parent side. Returns text safe for public errors, or "" when the child left
 * no valid record. Only steps from the caller's closed list are echoed. */
export async function readPrivateChildFailure(directory: string, steps: readonly string[]): Promise<string> {
  try {
    const raw = await readFile(path.join(directory, PRIVATE_CHILD_FAILURE_FILENAME), "utf8");
    if (raw.length > 256) return "";
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Object.keys(value).some(key => key !== "step" && key !== "errorClass")) return "";
    const step = typeof value.step === "string" && steps.includes(value.step) ? value.step : "unknown";
    const errorClass = (ERROR_CLASSES as readonly unknown[]).includes(value.errorClass) ? value.errorClass as ErrorClass : "Error";
    return ` at step ${step} (${errorClass})`;
  } catch { return ""; }
}
