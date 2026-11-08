import { readFileSync } from "node:fs";

/** Trusted evidence modules whose fixed refusal messages may be named publicly. */
export const PRIVATE_REFUSAL_MODULES = [
  "manual-private-transfer.ts", "manual-private-handoff.ts", "manual-private-retention.ts", "manual-private-report-assets.ts",
  "private-history.ts", "private-framework-report.ts", "history-budget.ts", "evidence.ts", "redaction.ts",
  "manual-dispatch-authority.ts", "testops-chat-admission.ts",
] as const;

let known: ReadonlySet<string> | undefined;
/** Literal `new Error("...")` messages in the trusted modules; dynamic messages are never included. */
export function fixedRefusalMessages(): ReadonlySet<string> {
  known ??= new Set(PRIVATE_REFUSAL_MODULES.flatMap(file => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    return [...source.matchAll(/new Error\("([^"$`\\]+)"\)/g)].map(match => match[1]!);
  }));
  return known;
}

/**
 * A closed, public-safe name for why a private evidence operation refused. Only a fixed literal
 * message from the trusted modules is named (as a slug); otherwise a Node error code, an error type,
 * or "dynamic". The message text of anything else is never returned.
 */
export function privateRefusalCode(error: unknown, fixed?: ReadonlySet<string>): string {
  // Naming must never prevent the fixed failure line: a module read failure degrades to "unnamed".
  try { return refusalCode(error, fixed ?? fixedRefusalMessages()); } catch { return "unnamed"; }
}
function refusalCode(error: unknown, fixed: ReadonlySet<string>): string {
  if (!(error instanceof Error)) return "non-error-thrown";
  if (fixed.has(error.message)) return error.message.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96);
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && /^(?:E[A-Z]{2,15}|ERR_[A-Z0-9_]{2,48})$/.test(code)) return `fs-${code}`;
  if (error.name !== "Error" && /^[A-Z][A-Za-z]{2,40}$/.test(error.name)) return `error-type-${error.name}`;
  return "dynamic";
}
