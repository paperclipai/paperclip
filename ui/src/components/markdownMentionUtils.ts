export interface MentionState {
  query: string;
  top: number;
  left: number;
  textNode: Text | null;
  atPos: number | null;
  endPos: number | null;
}

function extractInlineMentionState(textNode: Text | null, offset: number): Pick<MentionState, "query" | "textNode" | "atPos" | "endPos"> | null {
  if (!textNode) return null;

  const text = textNode.textContent ?? "";

  let atPos = -1;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i;
      }
      break;
    }
    if (/\s/.test(ch)) break;
  }

  if (atPos === -1) return null;

  return {
    query: text.slice(atPos + 1, offset),
    textNode,
    atPos,
    endPos: offset,
  };
}

function extractMentionQuery(container: HTMLElement, range: Range): string | null {
  const beforeCaret = range.cloneRange();
  beforeCaret.selectNodeContents(container);
  beforeCaret.setEnd(range.startContainer, range.startOffset);

  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret.toString());
  return match ? match[1] ?? "" : null;
}

export function detectMention(container: HTMLElement): MentionState | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;

  const isTextNodeCaret = range.startContainer.nodeType === Node.TEXT_NODE;
  const inlineState = isTextNodeCaret
    ? extractInlineMentionState(range.startContainer as Text, range.startOffset)
    : null;

  const query = isTextNodeCaret ? inlineState?.query ?? null : extractMentionQuery(container, range);
  if (query == null) return null;

  const rect = typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : ({ top: 0, left: 0, bottom: 0 } as DOMRect);
  const containerRect = container.getBoundingClientRect();

  return {
    query,
    top: rect.bottom - containerRect.top,
    left: rect.left - containerRect.left,
    textNode: inlineState?.textNode ?? null,
    atPos: inlineState?.atPos ?? null,
    endPos: inlineState?.endPos ?? null,
  };
}
