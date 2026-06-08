import type { DocumentSuggestionKind } from "./constants.js";

export interface CriticMarkupSuggestion {
  kind: DocumentSuggestionKind;
  selectedText: string;
  proposedText: string | null;
  markdownStart: number;
  markdownEnd: number;
}

export interface ParseCriticMarkupResult {
  plainMarkdown: string;
  suggestions: CriticMarkupSuggestion[];
}

export function parseCriticMarkup(markdown: string): ParseCriticMarkupResult {
  let index = 0;
  let lineStart = true;
  let inFence = false;
  let plainMarkdown = "";
  const suggestions: CriticMarkupSuggestion[] = [];

  const append = (value: string) => {
    plainMarkdown += value;
    lineStart = value.endsWith("\n");
  };

  while (index < markdown.length) {
    const rest = markdown.slice(index);
    const fence = lineStart ? rest.match(/^(\s*)(```+|~~~+)/) : null;
    if (fence) {
      const lineEnd = markdown.indexOf("\n", index);
      const end = lineEnd === -1 ? markdown.length : lineEnd + 1;
      append(markdown.slice(index, end));
      index = end;
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      const lineEnd = markdown.indexOf("\n", index);
      const end = lineEnd === -1 ? markdown.length : lineEnd + 1;
      append(markdown.slice(index, end));
      index = end;
      continue;
    }

    const tick = rest.match(/^`+/);
    if (tick) {
      const marker = tick[0];
      const close = markdown.indexOf(marker, index + marker.length);
      const end = close === -1 ? index + marker.length : close + marker.length;
      append(markdown.slice(index, end));
      index = end;
      continue;
    }

    if (rest.startsWith("{++")) {
      const close = markdown.indexOf("++}", index + 3);
      if (close !== -1) {
        const proposedText = markdown.slice(index + 3, close);
        const start = plainMarkdown.length;
        append(proposedText);
        suggestions.push({
          kind: "insertion",
          selectedText: "",
          proposedText,
          markdownStart: start,
          markdownEnd: start + proposedText.length,
        });
        index = close + 3;
        continue;
      }
    }

    if (rest.startsWith("{--")) {
      const close = markdown.indexOf("--}", index + 3);
      if (close !== -1) {
        const selectedText = markdown.slice(index + 3, close);
        const start = plainMarkdown.length;
        suggestions.push({
          kind: "deletion",
          selectedText,
          proposedText: null,
          markdownStart: start,
          markdownEnd: start,
        });
        index = close + 3;
        continue;
      }
    }

    if (rest.startsWith("{~~")) {
      const middle = markdown.indexOf("~>", index + 3);
      const close = middle === -1 ? -1 : markdown.indexOf("~~}", middle + 2);
      if (middle !== -1 && close !== -1) {
        const selectedText = markdown.slice(index + 3, middle);
        const proposedText = markdown.slice(middle + 2, close);
        const start = plainMarkdown.length;
        append(proposedText);
        suggestions.push({
          kind: "substitution",
          selectedText,
          proposedText,
          markdownStart: start,
          markdownEnd: start + proposedText.length,
        });
        index = close + 3;
        continue;
      }
    }

    append(markdown[index] ?? "");
    index += 1;
  }

  return { plainMarkdown, suggestions };
}

export function renderCriticMarkupSuggestion(
  suggestion: Pick<CriticMarkupSuggestion, "kind" | "selectedText" | "proposedText">,
) {
  if (suggestion.kind === "insertion") return `{++${suggestion.proposedText ?? ""}++}`;
  if (suggestion.kind === "deletion") return `{--${suggestion.selectedText}--}`;
  return `{~~${suggestion.selectedText}~>${suggestion.proposedText ?? ""}~~}`;
}
