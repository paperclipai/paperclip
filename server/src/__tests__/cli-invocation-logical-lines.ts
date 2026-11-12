// ── Backslash line continuation ───────────────────────────────────────────
//
// A shell reads a backslash at the end of a line as a line join. So one
// command can spread its content-bearing arguments across many physical
// lines. The scan must see the whole command, not one physical line. If it
// checks each physical line alone, a `pnpm paperclipai` command whose unsafe
// argument sits on a later line passes undetected.
//
// `toLogicalLines` joins each backslash-continued physical line to the next
// one. It returns the joined text and the line number of the first physical
// line, so an offender report still points to the start of the command.

interface LogicalLine {
  text: string;
  lineNumber: number;
}

export function toLogicalLines(source: string): LogicalLine[] {
  const physicalLines = source.split("\n");
  const logicalLines: LogicalLine[] = [];
  let buffer: string | null = null;
  let startLine = 0;
  physicalLines.forEach((physicalLine, index) => {
    const continues = /\\\s*$/.test(physicalLine);
    const body = physicalLine.replace(/\\\s*$/, "");
    if (buffer === null) {
      startLine = index + 1;
      buffer = body;
    } else {
      buffer += body;
    }
    if (!continues) {
      logicalLines.push({ text: buffer, lineNumber: startLine });
      buffer = null;
    }
  });
  if (buffer !== null) {
    logicalLines.push({ text: buffer, lineNumber: startLine });
  }
  return logicalLines;
}

// A line that recommends the broken `pnpm exec paperclipai` form. A warning line
// names the broken form on purpose to tell the reader not to use it. Skip such a
// line, so the note itself does not trip the ban.
export function recommendsBrokenExecForm(line: string): boolean {
  if (!line.includes("pnpm exec paperclipai")) return false;
  const lower = line.toLowerCase();
  const warns =
    lower.includes("broken") ||
    lower.includes("not found") ||
    lower.includes("do not use");
  return !warns;
}
