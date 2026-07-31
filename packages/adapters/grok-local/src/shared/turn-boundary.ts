// Grok's `--output-format streaming-json` mode emits `thought` and `text` events
// token-by-token. Between reasoning turns (around tool calls) it drops the `\n`
// separator that the non-streaming `--output-format json` mode includes in the
// aggregated `thought` field. This helper inserts a single `\n` when a new chunk
// would otherwise glue two turns together (e.g. ``"`"`` then `"The"` => `` `The``).

export interface TurnBoundaryState {
  lastChunk: string;
  backtickParity: 0 | 1;
}

export function createTurnBoundaryState(): TurnBoundaryState {
  return { lastChunk: "", backtickParity: 0 };
}

function countBackticks(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === "`") count += 1;
  return count;
}

function endsWithSentenceClose(ch: string): boolean {
  return ch === "." || ch === "?" || ch === "!" || ch === ":" || ch === ";";
}

export function applyTurnBoundary(state: TurnBoundaryState, incoming: string): string {
  if (!incoming) return incoming;

  let output = incoming;
  const prev = state.lastChunk;
  if (
    prev &&
    !/\s$/.test(prev) &&
    !/^\s/.test(incoming) &&
    /^[A-Z]/.test(incoming) &&
    incoming.length >= 2
  ) {
    const lastChar = prev[prev.length - 1]!;
    // Narrow the backtick trigger to a lone closing-backtick chunk (e.g. the
    // stream "...`", "ls", "`" then "The"). A compound chunk like "`ls`" is a
    // self-contained span and the following capitalized word is a continuation,
    // not a new turn.
    const closingLoneBacktick =
      prev === "`" && state.backtickParity === 0;
    const looksLikeNewTurn = endsWithSentenceClose(lastChar) || closingLoneBacktick;
    if (looksLikeNewTurn) {
      output = `\n${incoming}`;
    }
  }

  state.lastChunk = incoming;
  state.backtickParity = ((state.backtickParity + countBackticks(incoming)) % 2) as 0 | 1;
  return output;
}
