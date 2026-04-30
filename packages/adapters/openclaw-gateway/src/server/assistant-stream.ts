/**
 * Picks the next chunk to append to the running assistant transcript from a
 * single `stream === "assistant"` event payload.
 *
 * BPE-style tokenizers (qwen3, gpt, llama family) emit word-tokens with a
 * leading space (e.g. `["It", " seems", " there", " is"]`). The streamed
 * deltas therefore carry significant inter-word whitespace that the
 * transcript needs to preserve verbatim. Using the project's `nonEmpty()`
 * helper here would `.trim()` each chunk before pushing it, collapsing
 * inter-word spaces and producing run-on text like
 * `ItseemsthereisapersistentissuewiththePythoncommandsyntax`.
 *
 * Type-only checks plus a `length > 0` guard let us drop empty deltas while
 * keeping every other byte intact. The trailing
 * `assistantChunks.join("").trim()` at the end of the stream still trims
 * leading/trailing message whitespace, so this change only affects
 * mid-message preservation.
 */
export function pickAssistantChunk(data: Record<string, unknown>): string | null {
  const delta = typeof data.delta === "string" ? data.delta : null;
  if (delta !== null && delta.length > 0) return delta;
  const text = typeof data.text === "string" ? data.text : null;
  if (text !== null && text.length > 0) return text;
  return null;
}
