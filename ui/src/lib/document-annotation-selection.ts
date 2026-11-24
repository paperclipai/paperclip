import {
  createDocumentAnchorSelector,
  normalizeAnchorText,
  projectMarkdownToText,
  resolveProjectionRange,
  type DocumentAnnotationAnchorSelector,
  type DocumentTextProjection,
  type DocumentTextRange,
} from "@paperclipai/shared";

export interface ContainerTextOffset {
  /** Byte offset of the selection start within the flattened container text. */
  startOffset: number;
  /** Byte offset of the selection end within the flattened container text. */
  endOffset: number;
  /** Raw flattened text content of the container. */
  containerText: string;
  /** Raw text inside the selection. */
  selectedText: string;
}

function* annotationTextNodes(container: HTMLElement): Generator<Text | HTMLImageElement> {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text || node instanceof HTMLImageElement) yield node;
  }
}

function annotationText(container: HTMLElement): string {
  if (!container.querySelector("img[alt]")) return container.textContent ?? "";
  return Array.from(annotationTextNodes(container), node => node instanceof Text ? node.data : node.alt).join("");
}

export function getContainerTextOffset(
  container: HTMLElement,
  range: Range,
): ContainerTextOffset | null {
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const preRange = document.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);
  let startOffset = preRange.toString().length;
  preRange.setEnd(range.endContainer, range.endOffset);
  let endOffset = preRange.toString().length;
  if (endOffset <= startOffset) return null;
  for (const image of container.querySelectorAll<HTMLImageElement>("img[alt]")) {
    const relativePosition = range.comparePoint(image, 0);
    if (relativePosition < 0) startOffset += image.alt.length;
    if (relativePosition <= 0) endOffset += image.alt.length;
  }
  return {
    startOffset,
    endOffset,
    containerText: annotationText(container),
    selectedText: range.toString(),
  };
}

export interface SelectionAnchorResult {
  selector: DocumentAnnotationAnchorSelector;
  range: DocumentTextRange;
  projection: DocumentTextProjection;
}

export function buildAnchorFromContainerSelection(input: {
  markdown: string;
  containerOffset: ContainerTextOffset;
}): SelectionAnchorResult | null {
  const projection = projectMarkdownToText(input.markdown);
  const { containerText, selectedText, startOffset } = input.containerOffset;
  const needle = normalizeAnchorText(selectedText);
  if (!needle) return null;

  const leadingWhitespace = selectedText.length - selectedText.trimStart().length;
  const renderedText = normalizeAnchorText(containerText);
  const renderedStart = rawOffsetToNormalized(containerText, startOffset + leadingWhitespace);
  const best = mapOccurrenceBetweenTexts({
    fromText: renderedText,
    fromOffset: renderedStart,
    toText: projection.text,
    needle,
  });
  if (best == null) return null;

  const normalizedStart = best;
  const normalizedEnd = best + needle.length;
  const range = resolveProjectionRange(projection, normalizedStart, normalizedEnd);
  if (!range) return null;
  if (normalizeAnchorText(range.text) !== needle) return null;

  const selector = createDocumentAnchorSelector(projection, range);
  return { selector, range, projection };
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1) {
    out.push(cursor);
    cursor = haystack.indexOf(needle, cursor + 1);
  }
  return out;
}

function pickClosestOccurrence(occurrences: number[], expected: number): number | null {
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) return occurrences[0] ?? null;
  let best = occurrences[0] ?? 0;
  let bestDistance = Math.abs(best - expected);
  for (const candidate of occurrences) {
    const distance = Math.abs(candidate - expected);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function mapOccurrenceBetweenTexts(input: {
  fromText: string;
  fromOffset: number;
  toText: string;
  needle: string;
}): number | null {
  const toOccurrences = findAllOccurrences(input.toText, input.needle);
  if (toOccurrences.length === 0) return null;
  if (toOccurrences.length === 1) return toOccurrences[0] ?? null;

  const fromOccurrences = findAllOccurrences(input.fromText, input.needle);
  if (fromOccurrences.length === toOccurrences.length) {
    const fromMatch = pickClosestOccurrence(fromOccurrences, input.fromOffset);
    const ordinal = fromMatch == null ? -1 : fromOccurrences.indexOf(fromMatch);
    if (ordinal >= 0) return toOccurrences[ordinal] ?? null;
  }

  const ratio = input.fromOffset / Math.max(1, input.fromText.length);
  return pickClosestOccurrence(toOccurrences, Math.round(ratio * input.toText.length));
}

function rawOffsetToNormalized(rawText: string, rawOffset: number): number {
  let normalizedCursor = 0;
  let lastWasWhitespace = true;
  const end = Math.min(rawOffset, rawText.length);
  for (let index = 0; index < end; index += 1) {
    if (/\s/.test(rawText[index] ?? "")) {
      if (!lastWasWhitespace) {
        normalizedCursor += 1;
        lastWasWhitespace = true;
      }
      continue;
    }
    normalizedCursor += 1;
    lastWasWhitespace = false;
  }
  return normalizedCursor;
}

export function rangesForNormalizedSpan(input: {
  container: HTMLElement;
  selectedText: string;
  projectionText?: string;
  normalizedStart?: number;
}): Range[] {
  const normalizedNeedle = normalizeAnchorText(input.selectedText);
  if (!normalizedNeedle) return [];
  const { normalizedStart, projectionText } = input;
  const includeAlt = normalizedStart !== undefined && projectionText !== undefined;
  const containerText = includeAlt ? annotationText(input.container) : input.container.textContent ?? "";
  const normalizedContainerText = normalizeAnchorText(containerText);
  const containerOccurrenceIndex = includeAlt
    ? mapOccurrenceBetweenTexts({
      fromText: projectionText,
      fromOffset: normalizedStart,
      toText: normalizedContainerText,
      needle: normalizedNeedle,
    }) ?? -1
    : normalizedContainerText.indexOf(normalizedNeedle);
  if (containerOccurrenceIndex === -1) return [];

  // Convert from normalized container offset back to raw container offset
  // by walking the raw text and matching whitespace squashing.
  const rawIndex = mapNormalizedOffsetToRaw(containerText, containerOccurrenceIndex);
  if (rawIndex < 0) return [];

  const rawNeedleLength = matchRawLengthForNormalized(
    containerText.slice(rawIndex),
    normalizedNeedle.length,
  );
  if (rawNeedleLength <= 0) return [];

  const rawStart = rawIndex;
  const rawEnd = rawIndex + rawNeedleLength;
  return buildRangesForRawSpan(input.container, rawStart, rawEnd, includeAlt);
}

function mapNormalizedOffsetToRaw(rawText: string, normalizedOffset: number): number {
  let normalizedCursor = 0;
  let lastWasWhitespace = true; // mimic trim() at start
  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index] ?? "";
    if (/\s/.test(char)) {
      if (!lastWasWhitespace) {
        if (normalizedCursor === normalizedOffset) return index;
        normalizedCursor += 1;
        lastWasWhitespace = true;
      }
      continue;
    }
    if (normalizedCursor === normalizedOffset) return index;
    normalizedCursor += 1;
    lastWasWhitespace = false;
  }
  return -1;
}

function matchRawLengthForNormalized(rawTail: string, normalizedLength: number): number {
  let normalizedCount = 0;
  let lastWasWhitespace = false;
  for (let index = 0; index < rawTail.length; index += 1) {
    const char = rawTail[index] ?? "";
    if (/\s/.test(char)) {
      if (!lastWasWhitespace) {
        normalizedCount += 1;
        if (normalizedCount >= normalizedLength) return index;
        lastWasWhitespace = true;
      }
    } else {
      normalizedCount += 1;
      lastWasWhitespace = false;
      if (normalizedCount >= normalizedLength) return index + 1;
    }
  }
  return rawTail.length;
}

function buildRangesForRawSpan(container: HTMLElement, rawStart: number, rawEnd: number, includeAlt: boolean): Range[] {
  const ranges: Range[] = [];
  let cursor = 0;
  for (const textNode of annotationTextNodes(container)) {
    if (textNode instanceof HTMLImageElement) {
      if (includeAlt) cursor += textNode.alt.length;
      continue;
    }
    const length = textNode.data.length;
    const nodeStart = cursor;
    const nodeEnd = cursor + length;
    if (nodeEnd > rawStart && nodeStart < rawEnd) {
      const startWithin = Math.max(0, rawStart - nodeStart);
      const endWithin = Math.min(length, rawEnd - nodeStart);
      if (endWithin > startWithin) {
        const range = document.createRange();
        range.setStart(textNode, startWithin);
        range.setEnd(textNode, endWithin);
        ranges.push(range);
      }
    }
    cursor = nodeEnd;
    if (cursor >= rawEnd) break;
  }
  return ranges;
}
