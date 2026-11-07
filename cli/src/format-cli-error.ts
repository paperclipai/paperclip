const CAUSE_REDACTED = Symbol.for("paperclipai.cli.causeRedacted");

/**
 * Marks an error whose message was redacted while its raw `cause` was kept for
 * debugging. `formatCliError` then never prints that cause chain, so the
 * redacted values cannot reappear under "caused by:".
 */
export function markCauseRedacted<T extends Error>(err: T): T {
  Object.defineProperty(err, CAUSE_REDACTED, { value: true, enumerable: false });
  return err;
}

function isCauseRedacted(err: Error): boolean {
  return (err as unknown as Record<symbol, unknown>)[CAUSE_REDACTED] === true;
}

/**
 * Renders a top-level CLI failure, including its causes and AggregateError
 * members, so the real reason is never lost. Node connection failures (for
 * example localhost resolving to both ::1 and 127.0.0.1) throw an
 * AggregateError whose own message is empty; printing only `err.message` made
 * `paperclipai run` exit 1 with no visible reason. Errors marked with
 * `markCauseRedacted` print their message only.
 */
export function formatCliError(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) {
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err) ?? String(err);
    } catch {
      return String(err);
    }
  }

  const code = (err as { code?: unknown }).code;
  const message = err.message.trim();
  let line = message.length > 0 ? message : err.name || "Error";
  if (typeof code === "string" && !line.includes(code)) line = `${line} [${code}]`;
  if (depth >= 3 || isCauseRedacted(err)) return line;

  const indent = "  ".repeat(depth + 1);
  const details: string[] = [];
  if (err instanceof AggregateError) {
    for (const inner of err.errors) details.push(`${indent}- ${formatCliError(inner, depth + 1)}`);
  }
  if (err.cause !== undefined) {
    const cause = formatCliError(err.cause, depth + 1);
    // Wrappers such as install embed the cause message already; do not repeat it.
    if (!message.includes(cause)) details.push(`${indent}caused by: ${cause}`);
  }
  return details.length > 0 ? [line, ...details].join("\n") : line;
}
