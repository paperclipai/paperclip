export function parseDeflectorStdoutLine(
  line: string,
  ts: string,
): Array<{ kind: "stdout" | "stderr" | "system"; ts: string; text: string }> {
  return [{ kind: "stdout", ts, text: line }];
}
