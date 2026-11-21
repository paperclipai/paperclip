interface BlockquoteContainer {
  kind: "blockquote";
}

interface ListContainer {
  kind: "list";
  indent: number;
  emptyAtStart: boolean;
  sawBlank: boolean;
}

type ActiveContainer = BlockquoteContainer | ListContainer;

interface OpenFence {
  char: "`" | "~";
  length: number;
  containers: ActiveContainer[];
}

type FenceLineTransition = "inside" | "closed" | "ended_before_line";

const LIST_MARKER_RE = /^([-+*]|\d{1,9}[.)])(?:([ \t]+)|$)/;
const THEMATIC_BREAK_RE = /^(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/;
const ATX_HEADING_RE = /^#{1,6}(?:[ \t]|$)/;
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

function matchFenceRun(text: string): { char: "`" | "~"; length: number } | null {
  const fenceMatch = FENCE_RUN_RE.exec(text);
  if (!fenceMatch) return null;
  const run = fenceMatch[1];
  const char = run[0] as "`" | "~";
  if (char === "`" && fenceMatch[2].includes("`")) return null;
  return { char, length: run.length };
}

function matchListMarker(
  afterSpaces: string,
  leadingColumns: number,
  markerCol: number,
  interruptingParagraph: boolean,
): { indent: number; rest: string; col: number; emptyAtStart: boolean; indentedCode: boolean } | null {
  if (THEMATIC_BREAK_RE.test(afterSpaces)) return null;
  const listMatch = LIST_MARKER_RE.exec(afterSpaces);
  if (!listMatch) return null;
  const marker = listMatch[1];
  const markerLen = marker.length;
  const afterMarkerCol = markerCol + markerLen;
  const ws = leadingSpaceWidth(afterSpaces.slice(markerLen), afterMarkerCol);
  const afterWs = afterSpaces.slice(markerLen + ws.index);
  if (interruptingParagraph && /^\d/.test(marker) && marker !== "1." && marker !== "1)") {
    return null;
  }
  if (afterWs.length === 0) {
    if (interruptingParagraph) return null;
    return {
      indent: leadingColumns + markerLen + 1,
      rest: "",
      col: afterMarkerCol + 1,
      emptyAtStart: true,
      indentedCode: false,
    };
  }
  if (ws.columns >= 5) {
    return {
      indent: leadingColumns + markerLen + 1,
      rest: " ".repeat(ws.columns - 1) + afterWs,
      col: afterMarkerCol + 1,
      emptyAtStart: false,
      indentedCode: true,
    };
  }
  if (ws.columns >= 1) {
    return {
      indent: leadingColumns + markerLen + ws.columns,
      rest: afterWs,
      col: afterMarkerCol + ws.columns,
      emptyAtStart: false,
      indentedCode: false,
    };
  }
  return null;
}

function interruptsListContainer(text: string, startCol: number): boolean {
  const leading = leadingSpaceWidth(text, startCol);
  if (leading.columns > 3) return false;
  const afterSpaces = text.slice(leading.index);
  if (afterSpaces.startsWith(">")) return true;
  if (THEMATIC_BREAK_RE.test(afterSpaces)) return true;
  if (ATX_HEADING_RE.test(afterSpaces)) return true;
  if (matchFenceRun(afterSpaces)) return true;
  return LIST_MARKER_RE.test(afterSpaces);
}

function advanceOpenFence(fence: OpenFence, line: string): FenceLineTransition {
  let rest = line;
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

export function createMarkdownFenceTracker() {
  let openFence: OpenFence | null = null;
  let activeContainers: ActiveContainer[] = [];
  let paragraphOpen = false;

  return {
    step(rawLine: string): boolean {
      const line = stripTrailingCr(rawLine);

      if (openFence) {
        const transition = advanceOpenFence(openFence, line);
        if (transition !== "ended_before_line") {
          if (transition === "closed") {
            activeContainers = openFence.containers.map((container) =>
              container.kind === "list"
                ? { kind: "list", indent: container.indent, emptyAtStart: false, sawBlank: false }
                : container,
            );
            openFence = null;
          }
          paragraphOpen = false;
          return true;
        }
        openFence = null;
        paragraphOpen = false;
      }

      let rest = line;
      let col = 0;
      const nextContainers: ActiveContainer[] = [];

      for (let i = 0; i < activeContainers.length; i += 1) {
        const container = activeContainers[i];
        if (container.kind === "blockquote") {
          const stripped = stripBlockquoteMarker(rest, col);
          if (!stripped) break;
          nextContainers.push(container);
          rest = stripped.rest;
          col = stripped.col;
        } else {
          if (rest.trim().length === 0) {
            if (container.emptyAtStart) break;
            nextContainers.push({ ...container, sawBlank: true });
            continue;
          }
          const stripped = stripContainerIndent(rest, container.indent, col);
          if (!stripped) {
            if (!container.sawBlank && paragraphOpen && !interruptsListContainer(rest, col)) {
              nextContainers.push(container);
              activeContainers = nextContainers;
              return false;
            }
            break;
          }
          nextContainers.push({ kind: "list", indent: container.indent, emptyAtStart: false, sawBlank: false });
          rest = stripped.rest;
          col = stripped.col;
        }
      }

      if (rest.trim().length === 0) {
        activeContainers = nextContainers;
        paragraphOpen = false;
        return false;
      }

      const matchedAllContainers = nextContainers.length === activeContainers.length;
      let canInterruptParagraph = paragraphOpen && matchedAllContainers;
      let indentedCode = false;
      while (true) {
        const blockquote = stripBlockquoteMarker(rest, col);
        if (blockquote) {
          nextContainers.push({ kind: "blockquote" });
          rest = blockquote.rest;
          col = blockquote.col;
          canInterruptParagraph = false;
          continue;
        }

        const leading = leadingSpaceWidth(rest, col);
        if (leading.columns > 3) {
          if (!canInterruptParagraph) indentedCode = true;
          break;
        }

        const afterSpaces = rest.slice(leading.index);
        const markerCol = col + leading.columns;
        const listItem = matchListMarker(afterSpaces, leading.columns, markerCol, canInterruptParagraph);
        if (listItem) {
          nextContainers.push({
            kind: "list",
            indent: listItem.indent,
            emptyAtStart: listItem.emptyAtStart,
            sawBlank: false,
          });
          rest = listItem.rest;
          col = listItem.col;
          canInterruptParagraph = false;
          if (listItem.indentedCode) {
            indentedCode = true;
            break;
          }
          continue;
        }

        const fence = matchFenceRun(afterSpaces);
        if (fence) {
          openFence = {
            char: fence.char,
            length: fence.length,
            containers: nextContainers,
          };
          activeContainers = nextContainers;
          paragraphOpen = false;
          return true;
        }

        break;
      }

      activeContainers = nextContainers;
      const trimmed = rest.trim();
      if (trimmed.length === 0 || indentedCode || THEMATIC_BREAK_RE.test(trimmed) || ATX_HEADING_RE.test(trimmed)) {
        paragraphOpen = false;
      } else {
        paragraphOpen = true;
      }
      return false;
    },
  };
}
