import { markdownTable, plural, renderComments, type RestCommentThread } from "../documents-shared.js";
import type { RestPage, RestPageElement, RestPresentation, RestSlidesLink, RestTextContent, RestTextElement } from "./presentation.js";

export interface SlidesTableCellView {
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  text: string;
}

export interface SlidesElementView {
  objectId: string;
  type: string;
  title?: string;
  description?: string;
  placeholder?: string;
  text?: string;
  rows?: number;
  columns?: number;
  cells?: SlidesTableCellView[][];
  url?: string;
  spreadsheetId?: string;
  chartId?: number;
  children?: SlidesElementView[];
}

export interface SlideView {
  objectId: string;
  slideNumber: number;
  skipped?: boolean;
  elements: SlidesElementView[];
  speakerNotes?: { objectId: string; text: string };
}

export interface SlidesContent {
  presentationId: string;
  title: string;
  revisionId?: string;
  text: string;
  slides: SlideView[];
  notes?: string[];
  [key: string]: unknown;
}

interface Tally {
  images: number;
  videos: number;
  charts: number;
}

const TITLE_PLACEHOLDERS = new Set(["TITLE", "CENTERED_TITLE"]);

const ELEMENT_KINDS = ["shape", "table", "image", "video", "line", "wordArt", "sheetsChart", "elementGroup", "speakerSpotlight"] as const;

export function elementType(element: RestPageElement): string {
  const kind = ELEMENT_KINDS.find((name) => element[name] !== undefined);
  if (kind === "elementGroup") return "group";
  return kind ?? "unknown";
}

export function rawText(text: RestTextContent | undefined): string {
  return (text?.textElements ?? []).map((element) => element.textRun?.content ?? element.autoText?.content ?? "").join("");
}

export function slidesLinkTarget(link: RestSlidesLink | undefined): string | undefined {
  if (!link) return undefined;
  if (link.url) return link.url;
  if (link.pageObjectId) return `#slide=${link.pageObjectId}`;
  if (link.slideIndex !== undefined) return `#slide-number=${link.slideIndex + 1}`;
  if (link.relativeLink) return `#${link.relativeLink}`;
  return undefined;
}

function renderRun(element: RestTextElement): string {
  const run = element.textRun ?? element.autoText;
  const raw = run?.content ?? "";
  const trailing = raw.match(/\n*$/)![0];
  const body = raw.slice(0, raw.length - trailing.length);
  const target = slidesLinkTarget(run?.style?.link);
  return (body && target ? `[${body}](${target})` : body) + trailing;
}

export function textLines(text: RestTextContent | undefined): string[] {
  const paragraphs: Array<{ prefix: string; body: string }> = [];
  let current: { prefix: string; body: string } | undefined;
  for (const element of text?.textElements ?? []) {
    if (element.paragraphMarker) {
      const bullet = element.paragraphMarker.bullet;
      const prefix = bullet ? `${"  ".repeat(bullet.nestingLevel ?? 0)}${bullet.glyph?.trim() || "-"} ` : "";
      current = { prefix, body: "" };
      paragraphs.push(current);
    } else if (element.textRun || element.autoText) {
      if (!current) {
        current = { prefix: "", body: "" };
        paragraphs.push(current);
      }
      current.body += renderRun(element);
    }
  }
  const lines = paragraphs.map(({ prefix, body }) => `${prefix}${body.replace(/\n$/, "").replace(/\u000b/g, "\n")}`);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

function cellText(text: RestTextContent | undefined): string {
  return textLines(text).join("\n");
}

function label(kind: string, element: RestPageElement): string {
  const name = (element.title || element.description || "").replace(/\s+/g, " ").trim();
  return name ? `[${kind}: ${name}]` : `[${kind}]`;
}

export function elementLines(element: RestPageElement, tally: Tally): string[] {
  if (element.shape) {
    const lines = textLines(element.shape.text);
    if (lines.length && TITLE_PLACEHOLDERS.has(element.shape.placeholder?.type ?? "")) lines[0] = `### ${lines[0]}`;
    return lines;
  }
  if (element.table) {
    const rows = (element.table.tableRows ?? []).map((row) => (row.tableCells ?? []).map((cell) => ({
      text: cellText(cell.text),
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan,
      row: cell.location?.rowIndex,
      column: cell.location?.columnIndex,
    })));
    return markdownTable(rows, element.table.columns ?? 0);
  }
  if (element.image) {
    tally.images += 1;
    return [label("image", element)];
  }
  if (element.video) {
    tally.videos += 1;
    return [element.video.url ? `[video: ${element.video.url}]` : label("video", element)];
  }
  if (element.sheetsChart) {
    tally.charts += 1;
    return [label("chart", element)];
  }
  if (element.wordArt) return element.wordArt.renderedText ? [element.wordArt.renderedText] : [];
  if (element.elementGroup) return joinBlocks((element.elementGroup.children ?? []).map((child) => elementLines(child, tally)));
  return [];
}

function joinBlocks(blocks: string[][]): string[] {
  return blocks.filter((block) => block.length > 0).flatMap((block, index) => (index === 0 ? block : ["", ...block]));
}

export function elementView(element: RestPageElement): SlidesElementView {
  const base = {
    objectId: element.objectId ?? "",
    type: elementType(element),
    ...(element.title ? { title: element.title } : {}),
    ...(element.description ? { description: element.description } : {}),
  };
  if (element.shape) {
    const placeholder = element.shape.placeholder?.type;
    const text = rawText(element.shape.text);
    return { ...base, ...(placeholder ? { placeholder } : {}), ...(text ? { text } : {}) };
  }
  if (element.table) {
    return {
      ...base,
      rows: element.table.rows ?? element.table.tableRows?.length ?? 0,
      columns: element.table.columns ?? element.table.tableRows?.[0]?.tableCells?.length ?? 0,
      cells: (element.table.tableRows ?? []).map((row, rowIndex) => (row.tableCells ?? []).map((cell, columnIndex) => ({
        rowIndex: cell.location?.rowIndex ?? rowIndex,
        columnIndex: cell.location?.columnIndex ?? columnIndex,
        ...(cell.rowSpan !== undefined && cell.rowSpan !== 1 ? { rowSpan: cell.rowSpan } : {}),
        ...(cell.columnSpan !== undefined && cell.columnSpan !== 1 ? { columnSpan: cell.columnSpan } : {}),
        text: rawText(cell.text),
      }))),
    };
  }
  if (element.video?.url) return { ...base, url: element.video.url };
  if (element.sheetsChart) return { ...base, spreadsheetId: element.sheetsChart.spreadsheetId, chartId: element.sheetsChart.chartId };
  if (element.wordArt?.renderedText) return { ...base, text: element.wordArt.renderedText };
  if (element.elementGroup) return { ...base, children: (element.elementGroup.children ?? []).map(elementView) };
  return base;
}

export function speakerNotes(slide: RestPage): { objectId: string; element?: RestPageElement } | undefined {
  const notesPage = slide.slideProperties?.notesPage;
  const objectId = notesPage?.notesProperties?.speakerNotesObjectId;
  if (!objectId) return undefined;
  return { objectId, element: notesPage?.pageElements?.find((element) => element.objectId === objectId) };
}

function hasText(element: RestPageElement): boolean {
  if (element.shape) return !element.shape.placeholder && rawText(element.shape.text).trim() !== "";
  if (element.table) return (element.table.tableRows ?? []).some((row) => (row.tableCells ?? []).some((cell) => rawText(cell.text).trim() !== ""));
  if (element.wordArt) return Boolean(element.wordArt.renderedText);
  if (element.elementGroup) return (element.elementGroup.children ?? []).some(hasText);
  return false;
}

export function inheritedTextCount(presentation: RestPresentation): number {
  return [...(presentation.masters ?? []), ...(presentation.layouts ?? [])]
    .reduce((count, page) => count + (page.pageElements ?? []).filter(hasText).length, 0);
}

export interface RenderPresentationOptions {
  commentsRequested?: boolean;
}

export function renderPresentation(presentation: RestPresentation, options: RenderPresentationOptions = {}): SlidesContent {
  const tally: Tally = { images: 0, videos: 0, charts: 0 };
  const slides = presentation.slides ?? [];
  const sections: string[][] = [];
  const views: SlideView[] = slides.map((slide, index) => {
    const skipped = slide.slideProperties?.isSkipped === true;
    const elements = slide.pageElements ?? [];
    const notes = speakerNotes(slide);
    const notesLines = textLines(notes?.element?.shape?.text);
    const body = joinBlocks(elements.map((element) => elementLines(element, tally)));
    sections.push([
      `## Slide ${index + 1}${skipped ? " (skipped)" : ""}`,
      ...body,
      ...(notesLines.length ? ["", "Speaker notes:", ...notesLines] : []),
    ]);
    return {
      objectId: slide.objectId ?? "",
      slideNumber: index + 1,
      ...(skipped ? { skipped } : {}),
      elements: elements.map(elementView),
      ...(notes ? { speakerNotes: { objectId: notes.objectId, text: rawText(notes.element?.shape?.text) } } : {}),
    };
  });
  const lines = sections.flatMap((section, index) => (index === 0 ? section : ["", ...section]));
  if (options.commentsRequested) {
    const threads: Array<{ thread: RestCommentThread; slide?: number }> = [
      ...(presentation.comments ?? []).map((thread) => ({ thread })),
      ...slides.flatMap((slide, index) => (slide.comments ?? []).map((thread) => ({ thread, slide: index + 1 }))),
    ];
    const where = new Map(threads.map(({ thread, slide }) => [thread, slide]));
    if (lines.length) lines.push("");
    lines.push("[Comments]", ...(threads.length
      ? renderComments(threads.map(({ thread }) => thread), (thread) => {
        const slide = where.get(thread);
        return slide ? `slide ${slide}` : undefined;
      })
      : ["No comments."]));
  }
  const notes: string[] = [];
  if (tally.images) notes.push(`${plural(tally.images, "image is", "images are")} shown as [image] with its title or alt text; the picture itself is not included.`);
  if (tally.videos) notes.push(`${plural(tally.videos, "video is", "videos are")} shown as [video] with its link when there is one.`);
  if (tally.charts) notes.push(`${plural(tally.charts, "chart is", "charts are")} shown as [chart]; chart data is not included.`);
  const inherited = inheritedTextCount(presentation);
  if (inherited) notes.push(`${plural(inherited, "text item", "text items")} on slide masters or layouts (for example a footer or logo text shown on every slide) ${inherited === 1 ? "is" : "are"} not included.`);
  return {
    presentationId: presentation.presentationId ?? "",
    title: presentation.title ?? "",
    ...(presentation.revisionId ? { revisionId: presentation.revisionId } : {}),
    text: lines.join("\n"),
    slides: views,
    ...(notes.length ? { notes } : {}),
  };
}
