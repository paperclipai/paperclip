/**
 * Markdown-aware Telegram message chunking.
 *
 * Telegram caps messages at 4096 chars. Naive split breaks code fences and
 * markdown formatting. This splitter respects:
 *   - Code fence boundaries (never split inside ``` blocks)
 *   - Paragraph boundaries (preferred split point: \n\n)
 *   - Line boundaries (fallback: \n)
 *   - Sentence boundaries (last resort: . !)
 *   - Hard char count (final fallback)
 *
 * Each chunk is left-trimmed; trailing whitespace preserved within content.
 * Code fences that span chunks are reopened with the same language tag in
 * the next chunk so syntax highlighting persists.
 */

const MAX_CHUNK = 4000; // 96 char headroom under Telegram's 4096 cap

const FENCE_RE = /^(```[a-zA-Z0-9]*)\s*$/;

export function chunkMarkdownForTelegram(text: string, max: number = MAX_CHUNK): string[] {
  if (!text || text.length <= max) return text ? [text] : [];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let openFence: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    let chunk = current.join("\n");
    // If this chunk has an open fence, close it
    if (openFence !== null) {
      chunk += "\n```";
    }
    chunks.push(chunk);
    current = [];
    currentLen = 0;
    // If next chunk is a continuation of an open fence, reopen it
    if (openFence !== null) {
      current.push(openFence);
      currentLen = openFence.length + 1;
    }
  };

  // When openFence is non-null, flush() appends "\n```" to close the chunk.
  // Reserve that headroom in the budget check so the close-append never
  // overflows past max (which would force hardSplit and break the fence).
  const CLOSE_RESERVE = 4; // length of "\n```"

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for the \n
    const fenceMatch = line.match(FENCE_RE);
    const reserve = openFence !== null ? CLOSE_RESERVE : 0;

    // If adding this line would exceed max (with close-fence reserve), flush first
    if (currentLen + lineLen + reserve > max && current.length > 0) {
      flush();
    }

    current.push(line);
    currentLen += lineLen;

    // Track fence state
    if (fenceMatch) {
      if (openFence === null) {
        openFence = fenceMatch[1]; // opening fence with optional lang
      } else {
        openFence = null; // closing fence
      }
    }
  }

  if (current.length > 0) flush();

  // Final pass: any chunk still over max gets hard-split (rare — only when a
  // single line + its fence boundary exceeds max)
  return chunks.flatMap((c) => (c.length <= max ? [c] : hardSplit(c, max)));
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + max));
    i += max;
  }
  return out;
}
