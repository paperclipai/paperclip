export function printDeflectorStreamEvent(event: unknown): void {
  if (typeof event === "string") {
    process.stdout.write(event.endsWith("\n") ? event : `${event}\n`);
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {
    process.stdout.write(String(event) + "\n");
  }
}
