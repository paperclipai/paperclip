import type {
  DocumentAnnotationAnchorConfidence,
  DocumentAnnotationAnchorState,
} from "./constants.js";
import type {
  DocumentAnnotationAnchorSelector,
  DocumentAnnotationAnchorSnapshot,
  DocumentTextPosition,
  DocumentTextProjection,
  DocumentTextRange,
} from "./types/document-annotation.js";

export interface CreateDocumentAnchorSelectorOptions {
  contextLength?: number;
}

export interface VerifyDocumentAnchorSelectorInput {
  markdown: string;
  selector: DocumentAnnotationAnchorSelector;
  contextLength?: number;
}

export interface VerifyDocumentAnchorSelectorResult {
  ok: boolean;
  anchor: DocumentAnnotationAnchorSnapshot | null;
  projection: DocumentTextProjection;
  reason: "verified" | "quote_mismatch" | "position_mismatch" | "invalid_range";
}

export interface RemapDocumentAnchorInput {
  previousAnchor: DocumentAnnotationAnchorSnapshot;
  nextMarkdown: string;
  contextLength?: number;
}

export interface RemapDocumentAnchorResult {
  anchorState: DocumentAnnotationAnchorState;
  confidence: DocumentAnnotationAnchorConfidence;
  anchor: DocumentAnnotationAnchorSnapshot | null;
  projection: DocumentTextProjection;
  reason: "exact" | "duplicate" | "fuzzy" | "ambiguous" | "missing";
}

interface Candidate {
  start: number;
  end: number;
  score: number;
  reason: RemapDocumentAnchorResult["reason"];
}

const DEFAULT_CONTEXT_LENGTH = 48;
const INLINE_IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]*)\)/;
const INLINE_LINK_PATTERN = /^\[([^\]]+)\]\(([^)]*)\)/;

export function normalizeAnchorText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function projectMarkdownToText(markdown: string): DocumentTextProjection {
  const builder = new ProjectionBuilder(markdown);
  const lines = markdown.match(/[^\n]*(?:\n|$)/g) ?? [markdown];
  let offset = 0;
  let inFence = false;

  for (const rawLine of lines) {
    if (rawLine === "") continue;
    const hasNewline = rawLine.endsWith("\n");
    const line = hasNewline ? rawLine.slice(0, -1) : rawLine;
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);

    if (fenceMatch) {
      inFence = !inFence;
      offset += rawLine.length;
      builder.addSeparator(offset - (hasNewline ? 1 : 0));
      continue;
    }

    if (inFence) {
      builder.addText(line, offset);
      builder.addSeparator(offset + line.length);
      offset += rawLine.length;
      continue;
    }

    const { text, sourceOffset } = stripBlockSyntax(line, offset);
    addInlineMarkdownText(builder, text, sourceOffset);
    builder.addSeparator(offset + line.length);
    offset += rawLine.length;
  }

  return builder.toProjection();
}

export function resolveProjectionRange(
  projection: DocumentTextProjection,
  normalizedStart: number,
  normalizedEnd: number,
): DocumentTextRange | null {
  if (
    normalizedStart < 0
    || normalizedEnd <= normalizedStart
    || normalizedEnd > projection.text.length
    || normalizedStart >= projection.positions.length
    || normalizedEnd - 1 >= projection.positions.length
  ) {
    return null;
  }

  return {
    text: projection.text.slice(normalizedStart, normalizedEnd),
    normalizedStart,
    normalizedEnd,
    markdownStart: projection.positions[normalizedStart]?.sourceStart ?? 0,
    markdownEnd: projection.positions[normalizedEnd - 1]?.sourceEnd ?? 0,
  };
}

export function createDocumentAnchorSelector(
  projection: DocumentTextProjection,
  range: DocumentTextRange,
  options: CreateDocumentAnchorSelectorOptions = {},
): DocumentAnnotationAnchorSelector {
  const contextLength = options.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  return {
    quote: {
      exact: range.text,
      prefix: projection.text.slice(Math.max(0, range.normalizedStart - contextLength), range.normalizedStart),
      suffix: projection.text.slice(range.normalizedEnd, range.normalizedEnd + contextLength),
    },
    position: {
      normalizedStart: range.normalizedStart,
      normalizedEnd: range.normalizedEnd,
      markdownStart: range.markdownStart,
      markdownEnd: range.markdownEnd,
    },
  };
}

export function selectorToAnchorSnapshot(selector: DocumentAnnotationAnchorSelector): DocumentAnnotationAnchorSnapshot {
  return {
    selectedText: selector.quote.exact,
    prefixText: selector.quote.prefix,
    suffixText: selector.quote.suffix,
    normalizedStart: selector.position.normalizedStart,
    normalizedEnd: selector.position.normalizedEnd,
    markdownStart: selector.position.markdownStart,
    markdownEnd: selector.position.markdownEnd,
  };
}

export function anchorSnapshotToSelector(anchor: DocumentAnnotationAnchorSnapshot): DocumentAnnotationAnchorSelector {
  return {
    quote: {
      exact: anchor.selectedText,
      prefix: anchor.prefixText,
      suffix: anchor.suffixText,
    },
    position: {
      normalizedStart: anchor.normalizedStart,
      normalizedEnd: anchor.normalizedEnd,
      markdownStart: anchor.markdownStart,
      markdownEnd: anchor.markdownEnd,
    },
  };
}

export function verifyDocumentAnchorSelector(
  input: VerifyDocumentAnchorSelectorInput,
): VerifyDocumentAnchorSelectorResult {
  const projection = projectMarkdownToText(input.markdown);
  const range = resolveProjectionRange(
    projection,
    input.selector.position.normalizedStart,
    input.selector.position.normalizedEnd,
  );
  if (!range) {
    return { ok: false, anchor: null, projection, reason: "invalid_range" };
  }

  if (normalizeAnchorText(range.text) !== normalizeAnchorText(input.selector.quote.exact)) {
    return { ok: false, anchor: null, projection, reason: "quote_mismatch" };
  }

  if (
    range.markdownStart !== input.selector.position.markdownStart
    || range.markdownEnd !== input.selector.position.markdownEnd
  ) {
    return { ok: false, anchor: null, projection, reason: "position_mismatch" };
  }

  const selector = createDocumentAnchorSelector(projection, range, {
    contextLength: input.contextLength ?? DEFAULT_CONTEXT_LENGTH,
  });
  return { ok: true, anchor: selectorToAnchorSnapshot(selector), projection, reason: "verified" };
}

export function remapDocumentAnchor(input: RemapDocumentAnchorInput): RemapDocumentAnchorResult {
  const projection = projectMarkdownToText(input.nextMarkdown);
  const contextLength = input.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  const quote = normalizeAnchorText(input.previousAnchor.selectedText);
  if (!quote) {
    return { anchorState: "orphaned", confidence: "missing", anchor: null, projection, reason: "missing" };
  }

  const exactCandidates = findOccurrences(projection.text, quote).map((start) => scoreCandidate({
    projection,
    start,
    end: start + quote.length,
    previousAnchor: input.previousAnchor,
    reason: "exact",
    contextLength,
  }));

  if (exactCandidates.length > 0) {
    exactCandidates.sort((a, b) => b.score - a.score);
    const [best, second] = exactCandidates;
    if (exactCandidates.length > 1 && (!second || Math.abs(best.score - second.score) < 0.05)) {
      return {
        anchorState: "stale",
        confidence: "ambiguous",
        anchor: buildAnchorSnapshot(projection, best.start, best.end, contextLength),
        projection,
        reason: "ambiguous",
      };
    }
    return {
      anchorState: "active",
      confidence: exactCandidates.length === 1 ? "exact" : "duplicate",
      anchor: buildAnchorSnapshot(projection, best.start, best.end, contextLength),
      projection,
      reason: exactCandidates.length === 1 ? "exact" : "duplicate",
    };
  }

  const fuzzy = findFuzzyCandidate(projection, input.previousAnchor, contextLength);
  if (fuzzy && fuzzy.score >= 0.58) {
    return {
      anchorState: "stale",
      confidence: "fuzzy",
      anchor: buildAnchorSnapshot(projection, fuzzy.start, fuzzy.end, contextLength),
      projection,
      reason: "fuzzy",
    };
  }

  return { anchorState: "orphaned", confidence: "missing", anchor: null, projection, reason: "missing" };
}

function stripBlockSyntax(line: string, absoluteOffset: number): { text: string; sourceOffset: number } {
  const blockMatch = line.match(/^\s{0,3}(?:(#{1,6})\s+|(?:[-+*]|\d+[.)])\s+|>\s?)/);
  if (!blockMatch) return { text: line, sourceOffset: absoluteOffset };
  return { text: line.slice(blockMatch[0].length), sourceOffset: absoluteOffset + blockMatch[0].length };
}

function addInlineMarkdownText(builder: ProjectionBuilder, text: string, sourceOffset: number): void {
  const formatting = formattingDelimiterIndexes(text);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const absolute = sourceOffset + index;
    const rest = text.slice(index);

    const image = rest.match(INLINE_IMAGE_PATTERN);
    if (image) {
      const altStart = absolute + 2;
      builder.addText(image[1] ?? "", altStart);
      index += image[0].length - 1;
      continue;
    }

    const link = rest.match(INLINE_LINK_PATTERN);
    if (link) {
      const labelStart = absolute + 1;
      builder.addText(link[1] ?? "", labelStart);
      index += link[0].length - 1;
      continue;
    }

    if (char === "`") {
      const closing = text.indexOf("`", index + 1);
      if (closing > index + 1) {
        builder.addText(text.slice(index + 1, closing), absolute + 1);
        index = closing;
        continue;
      }
    }

    if (char === "|" || char === "\t") {
      builder.addSeparator(absolute);
      continue;
    }

    if (formatting.has(index)) continue;
    if (char === "\\" && isAsciiPunctuation(text[index + 1])) {
      builder.addChar(text[index + 1] ?? "", absolute + 1, absolute + 2);
      index += 1;
      continue;
    }

    builder.addChar(char, absolute, absolute + 1);
  }
}

interface DelimiterRun {
  char: string;
  start: number;
  length: number;
  remaining: number;
  usedFromStart: number;
  usedFromEnd: number;
  scope: number;
  canOpen: boolean;
  canClose: boolean;
}

function formattingDelimiterIndexes(text: string): Set<number> {
  const runs: DelimiterRun[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "!" || char === "[") {
      const rest = text.slice(index);
      const construct = rest.match(INLINE_IMAGE_PATTERN) ?? rest.match(INLINE_LINK_PATTERN);
      if (construct) {
        index += construct[0].length;
        continue;
      }
    }
    if (char === "`") {
      const closing = text.indexOf("`", index + 1);
      if (closing > index + 1) {
        index = closing + 1;
        continue;
      }
    }
    if (char === "\\" && isAsciiPunctuation(text[index + 1])) {
      index += 2;
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? " ";
    const after = text[end] ?? " ";
    const leftFlanking = (char !== "~" && after === "~")
      || (!isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before)));
    const rightFlanking = (char !== "~" && before === "~")
      || (!isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after)));
    const length = end - index;
    if (char !== "~" || length <= 2) {
      runs.push({
        char,
        start: index,
        length,
        remaining: length,
        usedFromStart: 0,
        usedFromEnd: 0,
        scope: -1,
        canOpen: char === "_" ? leftFlanking && (!rightFlanking || isPunctuation(before)) : leftFlanking,
        canClose: char === "_" ? rightFlanking && (!leftFlanking || isPunctuation(after)) : rightFlanking,
      });
    }
    index = end;
  }

  const formatting = new Set<number>();
  const strikethroughRuns = runs.filter((run) => run.char === "~");
  const emphasisRuns = runs.filter((run) => run.char !== "~");
  if (runs[0]?.char === "~") {
    const scopeAt = innermostSpanLookup(pairStrikethroughRuns(strikethroughRuns, formatting, () => -1));
    pairEmphasisRuns(emphasisRuns, formatting, (run) => scopeAt(run.start));
  } else {
    const scopeAt = innermostSpanLookup(pairEmphasisRuns(emphasisRuns, formatting, () => -1));
    pairStrikethroughRuns(strikethroughRuns, formatting, (run) => scopeAt(run.start));
  }
  return formatting;
}

type Span = [number, number];

function pairEmphasisRuns(runs: DelimiterRun[], formatting: Set<number>, scopeOf: (run: DelimiterRun) => number): Span[] {
  const spans: Span[] = [];
  const stacks = new Map<string, DelimiterRun[]>();
  const searchFloors = new Map<string, number>();
  const floorKey = (closer: DelimiterRun, canOpen: boolean, sizeClass: number) =>
    `${closer.scope}:${closer.char}:${canOpen}:${sizeClass}`;
  const findIn = (openers: DelimiterRun[], closer: DelimiterRun): number => {
    const key = floorKey(closer, closer.canOpen, closer.remaining % 3);
    const floor = Math.min(searchFloors.get(key) ?? 0, openers.length);
    const index = findOpener(openers, closer, floor);
    if (index === -1) searchFloors.set(key, openers.length);
    return index;
  };
  const lowerFloors = (closer: DelimiterRun, openerIndex: number) => {
    for (const canOpen of [true, false]) {
      for (let sizeClass = 0; sizeClass < 3; sizeClass += 1) {
        const key = floorKey(closer, canOpen, sizeClass);
        const floor = searchFloors.get(key);
        if (floor !== undefined && floor > openerIndex) searchFloors.set(key, openerIndex);
      }
    }
  };
  const stackFor = (scope: number, char: string): DelimiterRun[] => {
    const key = `${scope}:${char}`;
    let stack = stacks.get(key);
    if (!stack) {
      stack = [];
      stacks.set(key, stack);
    }
    return stack;
  };
  for (const closer of runs) {
    closer.scope = scopeOf(closer);
    const openers = stackFor(closer.scope, closer.char);
    if (closer.canClose) {
      let openerIndex = findIn(openers, closer);
      while (openerIndex !== -1 && closer.remaining > 0) {
        const opener = openers[openerIndex]!;
        const used = opener.remaining >= 2 && closer.remaining >= 2 ? 2 : 1;
        for (let offset = 0; offset < used; offset += 1) {
          formatting.add(opener.start + opener.length - 1 - opener.usedFromEnd - offset);
          formatting.add(closer.start + closer.usedFromStart + offset);
        }
        spans.push([opener.start + opener.length - opener.usedFromEnd, closer.start + closer.usedFromStart]);
        opener.usedFromEnd += used;
        opener.remaining -= used;
        closer.usedFromStart += used;
        closer.remaining -= used;
        openers.length = opener.remaining > 0 ? openerIndex + 1 : openerIndex;
        lowerFloors(closer, openerIndex);
        const others = stackFor(closer.scope, closer.char === "*" ? "_" : "*");
        while (others.length > 0 && others[others.length - 1]!.start > opener.start) others.pop();
        openerIndex = closer.remaining > 0 ? findIn(openers, closer) : -1;
      }
    }
    if (closer.canOpen && closer.remaining > 0) openers.push(closer);
  }
  return spans;
}

function pairStrikethroughRuns(runs: DelimiterRun[], formatting: Set<number>, scopeOf: (run: DelimiterRun) => number): Span[] {
  const spans: Span[] = [];
  const stacks = new Map<string, DelimiterRun[]>();
  const stackFor = (scope: number, length: number): DelimiterRun[] => {
    const key = `${scope}:${length}`;
    let stack = stacks.get(key);
    if (!stack) {
      stack = [];
      stacks.set(key, stack);
    }
    return stack;
  };
  for (const closer of runs) {
    closer.scope = scopeOf(closer);
    const openers = stackFor(closer.scope, closer.length);
    const opener = closer.canClose ? openers.pop() : undefined;
    if (opener) {
      const others = stackFor(closer.scope, closer.length === 1 ? 2 : 1);
      while (others.length > 0 && others[others.length - 1]!.start > opener.start) others.pop();
      for (let offset = 0; offset < closer.length; offset += 1) {
        formatting.add(opener.start + offset);
        formatting.add(closer.start + offset);
      }
      spans.push([opener.start + opener.length, closer.start]);
      continue;
    }
    if (closer.canOpen) openers.push(closer);
  }
  return spans;
}

function innermostSpanLookup(spans: Span[]): (position: number) => number {
  const sorted = [...spans].sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const open: Span[] = [];
  let next = 0;
  return (position) => {
    while (next < sorted.length && sorted[next]![0] <= position) open.push(sorted[next++]!);
    while (open.length > 0 && open[open.length - 1]![1] <= position) open.pop();
    return open.length > 0 ? open[open.length - 1]![0] : -1;
  };
}

function findOpener(openers: DelimiterRun[], closer: DelimiterRun, floor: number): number {
  for (let index = openers.length - 1; index >= floor; index -= 1) {
    const opener = openers[index]!;
    if (
      (opener.canClose || closer.canOpen)
      && closer.remaining % 3 !== 0
      && (opener.remaining + closer.remaining) % 3 === 0
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function isPunctuation(char: string): boolean {
  return /[\p{P}\p{S}]/u.test(char);
}

function isAsciiPunctuation(char: string | undefined): boolean {
  return char !== undefined && /^[!-/:-@[-`{-~]$/.test(char);
}

function findOccurrences(text: string, quote: string): number[] {
  const starts: number[] = [];
  let start = text.indexOf(quote);
  while (start !== -1) {
    starts.push(start);
    start = text.indexOf(quote, start + 1);
  }
  return starts;
}

function scoreCandidate(args: {
  projection: DocumentTextProjection;
  start: number;
  end: number;
  previousAnchor: DocumentAnnotationAnchorSnapshot;
  reason: Candidate["reason"];
  contextLength: number;
}): Candidate {
  const before = args.projection.text.slice(Math.max(0, args.start - args.contextLength), args.start);
  const after = args.projection.text.slice(args.end, args.end + args.contextLength);
  const prefixScore = suffixOverlapScore(args.previousAnchor.prefixText, before);
  const suffixScore = prefixOverlapScore(args.previousAnchor.suffixText, after);
  const distance = Math.abs(args.start - args.previousAnchor.normalizedStart);
  const proximity = 1 / (1 + distance / 200);
  return {
    start: args.start,
    end: args.end,
    score: prefixScore * 0.35 + suffixScore * 0.35 + proximity * 0.3,
    reason: args.reason,
  };
}

function findFuzzyCandidate(
  projection: DocumentTextProjection,
  previousAnchor: DocumentAnnotationAnchorSnapshot,
  contextLength: number,
): Candidate | null {
  const words = normalizeAnchorText(previousAnchor.selectedText).split(" ").filter(Boolean);
  if (words.length === 0) return null;
  const textWords = [...projection.text.matchAll(/\S+/g)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const windowSizes = new Set([words.length - 1, words.length, words.length + 1, words.length + 2].filter((n) => n > 0));
  let best: Candidate | null = null;

  for (const size of windowSizes) {
    for (let index = 0; index + size <= textWords.length; index += 1) {
      const window = textWords.slice(index, index + size);
      const candidateText = window.map((word) => word.text).join(" ");
      const similarity = similarityScore(normalizeAnchorText(previousAnchor.selectedText), candidateText);
      if (similarity < 0.45) continue;
      const scored = scoreCandidate({
        projection,
        start: window[0]?.start ?? 0,
        end: window[window.length - 1]?.end ?? 0,
        previousAnchor,
        reason: "fuzzy",
        contextLength,
      });
      scored.score = scored.score * 0.35 + similarity * 0.65;
      if (!best || scored.score > best.score) best = scored;
    }
  }

  return best;
}

function buildAnchorSnapshot(
  projection: DocumentTextProjection,
  normalizedStart: number,
  normalizedEnd: number,
  contextLength: number,
): DocumentAnnotationAnchorSnapshot {
  const range = resolveProjectionRange(projection, normalizedStart, normalizedEnd);
  if (!range) {
    return {
      selectedText: "",
      prefixText: "",
      suffixText: "",
      normalizedStart,
      normalizedEnd,
      markdownStart: 0,
      markdownEnd: 0,
    };
  }
  const selector = createDocumentAnchorSelector(projection, range, { contextLength });
  return selectorToAnchorSnapshot(selector);
}

function prefixOverlapScore(expectedPrefix: string, actualPrefix: string): number {
  const expected = normalizeAnchorText(expectedPrefix);
  const actual = normalizeAnchorText(actualPrefix);
  if (!expected) return 0.5;
  for (let size = Math.min(expected.length, actual.length); size > 0; size -= 1) {
    if (expected.slice(0, size) === actual.slice(0, size)) return size / expected.length;
  }
  return 0;
}

function suffixOverlapScore(expectedPrefix: string, actualPrefix: string): number {
  const expected = normalizeAnchorText(expectedPrefix);
  const actual = normalizeAnchorText(actualPrefix);
  if (!expected) return 0.5;
  for (let size = Math.min(expected.length, actual.length); size > 0; size -= 1) {
    if (expected.slice(-size) === actual.slice(-size)) return size / expected.length;
  }
  return 0;
}

function similarityScore(left: string, right: string): number {
  if (left === right) return 1;
  const leftWords = new Set(left.toLowerCase().split(/\s+/).filter(Boolean));
  const rightWords = new Set(right.toLowerCase().split(/\s+/).filter(Boolean));
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = new Set([...leftWords, ...rightWords]).size || 1;
  const jaccard = intersection / union;
  const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length, 1);
  return jaccard * 0.75 + lengthRatio * 0.25;
}

class ProjectionBuilder {
  private text = "";
  private positions: DocumentTextPosition[] = [];
  private pendingSpace: DocumentTextPosition | null = null;

  constructor(private readonly source: string) {}

  addText(text: string, sourceOffset: number): void {
    for (let index = 0; index < text.length; index += 1) {
      this.addChar(text[index] ?? "", sourceOffset + index, sourceOffset + index + 1);
    }
  }

  addSeparator(sourceOffset: number): void {
    this.addChar(" ", sourceOffset, sourceOffset + 1);
  }

  addChar(char: string, sourceStart: number, sourceEnd: number): void {
    if (/\s/.test(char)) {
      if (this.text.length > 0 && !this.pendingSpace) {
        this.pendingSpace = { sourceStart, sourceEnd };
      }
      return;
    }

    if (this.pendingSpace && this.text.length > 0) {
      this.text += " ";
      this.positions.push(this.pendingSpace);
    }
    this.pendingSpace = null;
    this.text += char;
    this.positions.push({ sourceStart, sourceEnd });
  }

  toProjection(): DocumentTextProjection {
    return {
      source: this.source,
      text: this.text,
      positions: this.positions,
    };
  }
}
