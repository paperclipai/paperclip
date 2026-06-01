function preserveNewlinesAsWhitespace(value: string) {
  return value.replace(/[^\n]/g, " ");
}

type FenceMatch = {
  marker: "`" | "~";
  length: number;
};

function matchFenceAtLineStart(markdown: string, index: number): FenceMatch | null {
  if (index > 0 && markdown[index - 1] !== "\n") return null;

  let cursor = index;
  let indent = 0;
  while (indent < 3 && markdown[cursor] === " ") {
    cursor += 1;
    indent += 1;
  }

  const marker = markdown[cursor];
  if (marker !== "`" && marker !== "~") return null;

  let length = 0;
  while (markdown[cursor + length] === marker) {
    length += 1;
  }

  if (length < 3) return null;

  return { marker, length };
}

export function stripMarkdownCode(markdown: string): string {
  if (!markdown) return "";

  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const fenceMatch = matchFenceAtLineStart(markdown, index);

    if (fenceMatch) {
      const blockStart = index;
      while (markdown[index] === " " && index < blockStart + 3) index += 1;
      index += fenceMatch.length;
      while (index < markdown.length && markdown[index] !== "\n") index += 1;
      if (index < markdown.length) index += 1;

      while (index < markdown.length) {
        const closingFenceMatch = matchFenceAtLineStart(markdown, index);
        if (
          closingFenceMatch &&
          closingFenceMatch.marker === fenceMatch.marker &&
          closingFenceMatch.length >= fenceMatch.length
        ) {
          while (markdown[index] === " ") index += 1;
          index += closingFenceMatch.length;
          while (index < markdown.length && markdown[index] !== "\n") index += 1;
          if (index < markdown.length) index += 1;
          break;
        }
        index += 1;
      }

      output += preserveNewlinesAsWhitespace(markdown.slice(blockStart, index));
      continue;
    }

    if (markdown[index] === "`") {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1;
      }
      const fence = "`".repeat(tickCount);
      const inlineStart = index;
      index += tickCount;
      const closeIndex = markdown.indexOf(fence, index);
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount);
        index = inlineStart + tickCount;
        continue;
      }
      index = closeIndex + tickCount;
      output += preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index));
      continue;
    }

    output += markdown[index]!;
    index += 1;
  }

  return output;
}
