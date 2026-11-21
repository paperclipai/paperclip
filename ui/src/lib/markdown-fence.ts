export type FenceContainer =
  | { kind: "blockquote" }
  | { kind: "list"; indent: number };

export interface OpenFence {
  char: "`" | "~";
  length: number;
  containers: FenceContainer[];
}

export type FenceLineTransition = "inside" | "closed" | "ended_before_line";

const LIST_MARKER_PREFIX_RE = /^([-+*]|\d{1,9}[.)])([ \t]+)/;
const FENCE_RUN_RE = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RUN_RE = /^(`{3,}|~{3,})[ \t]*$/;

export function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function leadingSpaceWidth(text: string, startCol: number): { index: number; columns: number } {
  let index = 0;
  let columns = 0;
  let col = startCol;
  while (index < text.length) {
    const ch = text[index];
    if (ch === " ") {
      columns += 1;
      col += 1;
      index += 1;
    } else if (ch === "\t") {
      const width = 4 - (col % 4);
      columns += width;
      col += width;
      index += 1;
    } else {
      break;
    }
  }
  return { index, columns };
}

function stripBlockquoteMarker(text: string, startCol: number): { rest: string; col: number } | null {
  const leading = leadingSpaceWidth(text, startCol);
  if (leading.columns > 3) return null;
  const afterSpaces = text.slice(leading.index);
  if (!afterSpaces.startsWith(">")) return null;
  const markerCol = startCol + leading.columns;
  if (afterSpaces[1] === " ") {
    return { rest: afterSpaces.slice(2), col: markerCol + 2 };
  }
  if (afterSpaces[1] === "\t") {
    const width = 4 - ((markerCol + 1) % 4);
    return { rest: " ".repeat(width - 1) + afterSpaces.slice(2), col: markerCol + 2 };
  }
  return { rest: afterSpaces.slice(1), col: markerCol + 1 };
}

function stripContainerIndent(text: string, indent: number, startCol: number): { rest: string; col: number } | null {
  let index = 0;
  let col = startCol;
  let consumed = 0;
  while (index < text.length && consumed < indent) {
    const ch = text[index];
    if (ch === " ") {
      consumed += 1;
      col += 1;
      index += 1;
    } else if (ch === "\t") {
      const width = 4 - (col % 4);
      const needed = indent - consumed;
      if (width > needed) {
        return {
          rest: " ".repeat(width - needed) + text.slice(index + 1),
          col: col + needed,
        };
      }
      consumed += width;
      col += width;
      index += 1;
    } else {
      return null;
    }
  }
  if (consumed < indent) return null;
  return { rest: text.slice(index), col };
}

export function parseFenceOpen(rawLine: string): OpenFence | null {
  let rest = stripTrailingCr(rawLine);
  let col = 0;
  const containers: FenceContainer[] = [];

  while (true) {
    const blockquote = stripBlockquoteMarker(rest, col);
    if (blockquote) {
      containers.push({ kind: "blockquote" });
      rest = blockquote.rest;
      col = blockquote.col;
      continue;
    }

    const leading = leadingSpaceWidth(rest, col);
    if (leading.columns > 3) return null;

    const afterSpaces = rest.slice(leading.index);
    const markerCol = col + leading.columns;
    const listMatch = LIST_MARKER_PREFIX_RE.exec(afterSpaces);
    if (listMatch) {
      const markerLen = listMatch[1].length;
      const afterMarkerCol = markerCol + markerLen;
      const ws = leadingSpaceWidth(afterSpaces.slice(markerLen), afterMarkerCol);
      const afterWs = afterSpaces.slice(markerLen + ws.index);
      if (ws.columns >= 1 && ws.columns <= 4 && afterWs.length > 0) {
        containers.push({ kind: "list", indent: leading.columns + markerLen + ws.columns });
        rest = afterWs;
        col = afterMarkerCol + ws.columns;
        continue;
      }
      if (ws.columns >= 5 && afterWs.length > 0) {
        return null;
      }
    }

    const fenceMatch = FENCE_RUN_RE.exec(afterSpaces);
    if (!fenceMatch) return null;
    const run = fenceMatch[1];
    const char = run[0] as "`" | "~";
    if (char === "`" && fenceMatch[2].includes("`")) return null;
    return { char, length: run.length, containers };
  }
}

export function advanceOpenFence(fence: OpenFence, rawLine: string): FenceLineTransition {
  let rest = stripTrailingCr(rawLine);
  let col = 0;

  for (let i = 0; i < fence.containers.length; i += 1) {
    const container = fence.containers[i];
    if (container.kind === "blockquote") {
      const stripped = stripBlockquoteMarker(rest, col);
      if (!stripped) return "ended_before_line";
      rest = stripped.rest;
      col = stripped.col;
    } else {
      if (rest.trim().length === 0) {
        const hasInnerBlockquote = fence.containers.slice(i + 1).some((entry) => entry.kind === "blockquote");
        return hasInnerBlockquote ? "ended_before_line" : "inside";
      }
      const stripped = stripContainerIndent(rest, container.indent, col);
      if (!stripped) return "ended_before_line";
      rest = stripped.rest;
      col = stripped.col;
    }
  }

  const closeLeading = leadingSpaceWidth(rest, col);
  if (closeLeading.columns <= 3) {
    const closeMatch = FENCE_CLOSE_RUN_RE.exec(rest.slice(closeLeading.index));
    if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.length) {
      return "closed";
    }
  }

  return "inside";
}
