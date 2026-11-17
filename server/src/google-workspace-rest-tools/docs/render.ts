import { markdownTable, OBJECT_PLACEHOLDER, plural, renderComments, tableGrid, type TableCellText } from "../documents-shared.js";
import type {
  RestDocsLink,
  RestDocument,
  RestDocumentTab,
  RestEmbeddedObject,
  RestNestingLevel,
  RestParagraph,
  RestParagraphElement,
  RestSegment,
  RestStructuralElement,
  RestSuggestible,
  RestTab,
} from "./document.js";

export interface DocsParagraphView {
  type: "paragraph";
  startIndex: number;
  endIndex: number;
  text: string;
  style?: string;
  list?: { listId: string; nestingLevel: number };
}

export interface DocsTableCellView {
  startIndex: number;
  endIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  content: DocsElementView[];
}

export interface DocsTableView {
  type: "table";
  startIndex: number;
  endIndex: number;
  rows: number;
  columns: number;
  cells: DocsTableCellView[][];
}

export interface DocsTableOfContentsView {
  type: "tableOfContents";
  startIndex: number;
  endIndex: number;
  content: DocsElementView[];
}

export interface DocsSectionBreakView {
  type: "sectionBreak";
  startIndex: number;
  endIndex: number;
}

export type DocsElementView = DocsParagraphView | DocsTableView | DocsTableOfContentsView | DocsSectionBreakView;

export interface DocsSegmentView {
  segmentId: string;
  kind?: string;
  footnoteNumber?: string;
  content: DocsElementView[];
}

export interface DocsTabView {
  tabId: string;
  title: string;
  parentTabId?: string;
  nestingLevel?: number;
  body: DocsElementView[];
  headers: DocsSegmentView[];
  footers: DocsSegmentView[];
  footnotes: DocsSegmentView[];
}

export interface DocsContent {
  documentId: string;
  title: string;
  revisionId?: string;
  suggestionsViewMode: SuggestionsView;
  text: string;
  tabs: DocsTabView[];
  notes: string[];
  [key: string]: unknown;
}

interface Tally {
  images: number;
  drawings: number;
  charts: number;
  equations: number;
  dropdowns: number;
}

interface TabContext {
  tab: RestDocumentTab;
  tally: Tally;
  counters: Map<string, number[]>;
  footnoteNumbers: Map<string, string>;
}

const ORDERED_GLYPHS = new Set(["DECIMAL", "ZERO_DECIMAL", "ALPHA", "UPPER_ALPHA", "ROMAN", "UPPER_ROMAN"]);
const HEADING_PREFIX: Record<string, string> = {
  TITLE: "# ",
  SUBTITLE: "## ",
  HEADING_1: "# ",
  HEADING_2: "## ",
  HEADING_3: "### ",
  HEADING_4: "#### ",
  HEADING_5: "##### ",
  HEADING_6: "###### ",
};

const indexOf = (value: number | undefined) => value ?? 0;

function letters(value: number): string {
  let result = "";
  for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(97 + ((n - 1) % 26)) + result;
  return result || "0";
}

function roman(value: number): string {
  if (value <= 0 || value >= 4000) return String(value);
  const table: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let rest = value;
  let result = "";
  for (const [amount, symbol] of table) {
    while (rest >= amount) {
      result += symbol;
      rest -= amount;
    }
  }
  return result;
}

export function formatListNumber(value: number, glyphType: string | undefined): string {
  switch (glyphType) {
    case "ZERO_DECIMAL": return value < 10 ? `0${value}` : String(value);
    case "ALPHA": return letters(value);
    case "UPPER_ALPHA": return letters(value).toUpperCase();
    case "ROMAN": return roman(value);
    case "UPPER_ROMAN": return roman(value).toUpperCase();
    default: return String(value);
  }
}

export function listMarker(levels: readonly RestNestingLevel[], counters: number[], level: number): string {
  const spec = levels[level] ?? {};
  const previous = counters[level];
  counters.length = level + 1;
  counters[level] = previous === undefined ? (spec.startNumber ?? 1) : previous + 1;
  if (!spec.glyphType || !ORDERED_GLYPHS.has(spec.glyphType)) return "-";
  const format = spec.glyphFormat || `%${level}.`;
  return format.replace(/%(\d)/g, (_match, digit: string) => {
    const at = Number(digit);
    return formatListNumber(counters[at] ?? levels[at]?.startNumber ?? 1, levels[at]?.glyphType);
  });
}

export function linkTarget(link: RestDocsLink | undefined): string | undefined {
  if (!link) return undefined;
  if (link.url) return link.url;
  const heading = link.heading?.id ?? link.headingId;
  if (heading) return `#heading=${heading}`;
  const bookmark = link.bookmark?.id ?? link.bookmarkId;
  if (bookmark) return `#bookmark=${bookmark}`;
  if (link.tabId) return `#tab=${link.tabId}`;
  return undefined;
}

function embeddedLabel(object: RestEmbeddedObject | undefined, tally: Tally): string {
  const label = (object?.title || object?.description || "").replace(/\s+/g, " ").trim();
  const suffix = label ? `: ${label}` : "";
  if (object?.linkedContentReference?.sheetsChartReference) {
    tally.charts += 1;
    return `[chart${suffix}]`;
  }
  if (object?.embeddedDrawingProperties) {
    tally.drawings += 1;
    return `[drawing${suffix}]`;
  }
  tally.images += 1;
  return `[image${suffix}]`;
}

function suggestible(element: RestParagraphElement): RestSuggestible | undefined {
  return element.textRun ?? element.autoText ?? element.pageBreak ?? element.columnBreak ?? element.footnoteReference
    ?? element.horizontalRule ?? element.equation ?? element.inlineObjectElement ?? element.person ?? element.richLink
    ?? element.dateElement ?? element.dropdown;
}

function inlineText(element: RestParagraphElement, context: TabContext): string {
  if (element.textRun) return element.textRun.content ?? "";
  if (element.autoText) {
    if (element.autoText.type === "PAGE_NUMBER") return "[page number]";
    if (element.autoText.type === "PAGE_COUNT") return "[page count]";
    return "[auto text]";
  }
  if (element.pageBreak) return "[page break]";
  if (element.columnBreak) return "[column break]";
  if (element.footnoteReference) {
    const number = element.footnoteReference.footnoteNumber ?? "?";
    if (element.footnoteReference.footnoteId) context.footnoteNumbers.set(element.footnoteReference.footnoteId, number);
    return `[^${number}]`;
  }
  if (element.horizontalRule) return "---";
  if (element.equation) {
    context.tally.equations += 1;
    return "[equation]";
  }
  if (element.inlineObjectElement) {
    const id = element.inlineObjectElement.inlineObjectId ?? "";
    return embeddedLabel(context.tab.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject, context.tally);
  }
  if (element.person) {
    const { name, email } = element.person.personProperties ?? {};
    if (name && email) return `${name} <${email}>`;
    return name || email || "[person]";
  }
  if (element.richLink) {
    const { title, uri } = element.richLink.richLinkProperties ?? {};
    return uri ? `[${title || uri}](${uri})` : title || "[link]";
  }
  if (element.dateElement) return element.dateElement.dateElementProperties?.displayText || "[date]";
  if (element.dropdown) {
    context.tally.dropdowns += 1;
    return "[dropdown]";
  }
  return "";
}

function renderInline(element: RestParagraphElement, context: TabContext): string {
  const raw = inlineText(element, context);
  const trailing = raw.match(/\n*$/)![0];
  let body = raw.slice(0, raw.length - trailing.length);
  if (!body) return raw;
  const target = linkTarget(element.textRun?.textStyle?.link);
  if (target) body = `[${body}](${target})`;
  const marks = suggestible(element);
  if (marks?.suggestedInsertionIds?.length) body = `{+${body}+}`;
  else if (marks?.suggestedDeletionIds?.length) body = `{-${body}-}`;
  return body + trailing;
}

export function paragraphRawText(paragraph: RestParagraph): string {
  return (paragraph.elements ?? []).map((element) => {
    if (element.textRun) return element.textRun.content ?? "";
    const length = Math.max(1, indexOf(element.endIndex) - indexOf(element.startIndex));
    return OBJECT_PLACEHOLDER.repeat(length);
  }).join("");
}

function paragraphLine(paragraph: RestParagraph, context: TabContext): string {
  let text = (paragraph.elements ?? []).map((element) => renderInline(element, context)).join("");
  text = text.replace(/\n$/, "").replace(/\u000b/g, "\n");
  for (const id of paragraph.positionedObjectIds ?? []) {
    const label = embeddedLabel(context.tab.positionedObjects?.[id]?.positionedObjectProperties?.embeddedObject, context.tally);
    text = text ? `${text} ${label}` : label;
  }
  if (paragraph.bullet) {
    const listId = paragraph.bullet.listId ?? "";
    const level = paragraph.bullet.nestingLevel ?? 0;
    const counters = context.counters.get(listId) ?? [];
    context.counters.set(listId, counters);
    const levels = context.tab.lists?.[listId]?.listProperties?.nestingLevels ?? [];
    return `${"  ".repeat(level)}${listMarker(levels, counters, level)} ${text}`;
  }
  const prefix = HEADING_PREFIX[paragraph.paragraphStyle?.namedStyleType ?? ""];
  return prefix && text ? `${prefix}${text}` : text;
}

function cellText(content: readonly RestStructuralElement[], context: TabContext): string {
  const parts: string[] = [];
  for (const element of content) {
    if (element.paragraph) parts.push(paragraphLine(element.paragraph, context));
    else if (element.table) {
      const rows = tableGrid(tableCells(element, context), element.table.columns ?? 0).map((cells) => cells.join(" / "));
      parts.push(`[table: ${rows.join("; ")}]`);
    } else if (element.tableOfContents) parts.push(cellText(element.tableOfContents.content ?? [], context));
  }
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.join("\n");
}

function tableCells(element: RestStructuralElement, context: TabContext): TableCellText[][] {
  return (element.table?.tableRows ?? []).map((row) => (row.tableCells ?? []).map((cell) => ({
    text: cellText(cell.content ?? [], context),
    rowSpan: cell.tableCellStyle?.rowSpan,
    columnSpan: cell.tableCellStyle?.columnSpan,
  })));
}

function tableLines(element: RestStructuralElement, context: TabContext): string[] {
  return markdownTable(tableCells(element, context), element.table?.columns ?? 0);
}

export function renderContent(content: readonly RestStructuralElement[], context: TabContext): string[] {
  const lines: string[] = [];
  let afterTable = false;
  for (const element of content) {
    if (element.paragraph) {
      const line = paragraphLine(element.paragraph, context);
      if (afterTable && line !== "") lines.push("");
      lines.push(line);
      afterTable = false;
    } else if (element.table) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(...tableLines(element, context));
      afterTable = true;
    } else if (element.tableOfContents) {
      lines.push("[Table of contents]", ...renderContent(element.tableOfContents.content ?? [], context));
      afterTable = false;
    } else if (element.sectionBreak && indexOf(element.startIndex) > 0) {
      lines.push("[section break]");
      afterTable = false;
    }
  }
  return lines;
}

function structure(content: readonly RestStructuralElement[]): DocsElementView[] {
  const views: DocsElementView[] = [];
  for (const element of content) {
    const startIndex = indexOf(element.startIndex);
    const endIndex = indexOf(element.endIndex);
    if (element.paragraph) {
      const style = element.paragraph.paragraphStyle?.namedStyleType;
      const bullet = element.paragraph.bullet;
      views.push({
        type: "paragraph",
        startIndex,
        endIndex,
        text: paragraphRawText(element.paragraph),
        ...(style && style !== "NORMAL_TEXT" ? { style } : {}),
        ...(bullet ? { list: { listId: bullet.listId ?? "", nestingLevel: bullet.nestingLevel ?? 0 } } : {}),
      });
    } else if (element.table) {
      views.push({
        type: "table",
        startIndex,
        endIndex,
        rows: element.table.rows ?? element.table.tableRows?.length ?? 0,
        columns: element.table.columns ?? element.table.tableRows?.[0]?.tableCells?.length ?? 0,
        cells: (element.table.tableRows ?? []).map((row) => (row.tableCells ?? []).map((cell) => {
          const rowSpan = cell.tableCellStyle?.rowSpan;
          const columnSpan = cell.tableCellStyle?.columnSpan;
          return {
            startIndex: indexOf(cell.startIndex),
            endIndex: indexOf(cell.endIndex),
            ...(rowSpan !== undefined && rowSpan !== 1 ? { rowSpan } : {}),
            ...(columnSpan !== undefined && columnSpan !== 1 ? { columnSpan } : {}),
            content: structure(cell.content ?? []),
          };
        })),
      });
    } else if (element.tableOfContents) {
      views.push({ type: "tableOfContents", startIndex, endIndex, content: structure(element.tableOfContents.content ?? []) });
    } else if (element.sectionBreak) {
      views.push({ type: "sectionBreak", startIndex, endIndex });
    }
  }
  return views;
}

const HEADER_KINDS: Array<[keyof NonNullable<RestDocumentTab["documentStyle"]>, string]> = [
  ["defaultHeaderId", "default"], ["firstPageHeaderId", "first page"], ["evenPageHeaderId", "even pages"],
  ["defaultFooterId", "default"], ["firstPageFooterId", "first page"], ["evenPageFooterId", "even pages"],
];

function segmentKind(tab: RestDocumentTab, id: string): string | undefined {
  return HEADER_KINDS.find(([field]) => tab.documentStyle?.[field] === id)?.[1];
}

function flattenTabs(tabs: readonly RestTab[], path: string[] = []): Array<{ tab: RestTab; path: string[] }> {
  return tabs.flatMap((tab) => {
    const here = [...path, tab.tabProperties?.title || "Untitled tab"];
    return [{ tab, path: here }, ...flattenTabs(tab.childTabs ?? [], here)];
  });
}

function numericOrder(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

interface RenderedTab {
  view: DocsTabView;
  lines: string[];
}

function renderTab(tab: RestTab, tally: Tally): RenderedTab {
  const documentTab = tab.documentTab ?? {};
  const context: TabContext = { tab: documentTab, tally, counters: new Map(), footnoteNumbers: new Map() };
  const lines = renderContent(documentTab.body?.content ?? [], context);
  const segments = (kind: "Header" | "Footer", record: Record<string, RestSegment> | undefined): DocsSegmentView[] =>
    Object.entries(record ?? {}).map(([id, segment]) => {
      const label = segmentKind(documentTab, id);
      const segmentLines = renderContent(segment.content ?? [], { ...context, counters: new Map() });
      while (segmentLines.length && segmentLines[segmentLines.length - 1] === "") segmentLines.pop();
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`[${kind}${label ? ` (${label})` : ""}]`, ...segmentLines);
      return { segmentId: id, ...(label ? { kind: label } : {}), content: structure(segment.content ?? []) };
    });
  const headers = segments("Header", documentTab.headers);
  const footers = segments("Footer", documentTab.footers);
  const footnoteEntries = Object.entries(documentTab.footnotes ?? {})
    .map(([id, segment]) => ({ id, segment, number: context.footnoteNumbers.get(id) }))
    .sort((a, b) => numericOrder(a.number) - numericOrder(b.number));
  const footnotes = footnoteEntries.map(({ id, segment, number }) => {
    const footnoteLines = renderContent(segment.content ?? [], { ...context, counters: new Map() })
      .map((line) => line.trim()).filter((line) => line !== "");
    if (lines.length && lines[lines.length - 1] !== "" && !lines[lines.length - 1]!.startsWith("[^")) lines.push("");
    lines.push(`[^${number ?? "?"}]: ${footnoteLines.join(" ")}`);
    return { segmentId: id, ...(number ? { footnoteNumber: number } : {}), content: structure(segment.content ?? []) };
  });
  const properties = tab.tabProperties ?? {};
  return {
    lines,
    view: {
      tabId: properties.tabId ?? "",
      title: properties.title ?? "",
      ...(properties.parentTabId ? { parentTabId: properties.parentTabId } : {}),
      ...(properties.nestingLevel ? { nestingLevel: properties.nestingLevel } : {}),
      body: structure(documentTab.body?.content ?? []),
      headers,
      footers,
      footnotes,
    },
  };
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end);
}

export function tallyNotes(tally: Tally): string[] {
  const notes: string[] = [];
  if (tally.images) notes.push(`${plural(tally.images, "image is", "images are")} shown as [image] with its title or alt text; the picture itself is not included.`);
  if (tally.drawings) notes.push(`${plural(tally.drawings, "drawing is", "drawings are")} shown as [drawing]; the Docs API does not return drawing content.`);
  if (tally.charts) notes.push(`${plural(tally.charts, "chart is", "charts are")} shown as [chart]; chart data is not included.`);
  if (tally.equations) notes.push(`${plural(tally.equations, "equation is", "equations are")} shown as [equation]; the Docs API does not return equation content.`);
  if (tally.dropdowns) notes.push(`${plural(tally.dropdowns, "dropdown is", "dropdowns are")} shown as [dropdown]; the Docs API does not return the selected value.`);
  return notes;
}

export type SuggestionsView = "SUGGESTIONS_INLINE" | "PREVIEW_WITHOUT_SUGGESTIONS";

export interface RenderDocumentOptions {
  commentsRequested?: boolean;
  suggestionsView?: SuggestionsView;
}

export const PREVIEW_NOTE = "Pending suggested edits are not shown: your access to this document does not include suggestions, so it was read in Google's PREVIEW_WITHOUT_SUGGESTIONS view. Google requires edits to be based on the SUGGESTIONS_INLINE view, so these indices may not be valid for update_doc.";
export const INLINE_NOTE = "Read in Google's SUGGESTIONS_INLINE view: pending suggested edits are included, marked {+inserted+} and {-deleted-}, and the indices are valid for update_doc.";
export const COMMENTS_UNAVAILABLE_NOTE = "Comments were asked for but are not available with your access to this document.";

export function renderDocument(document: RestDocument, options: RenderDocumentOptions = {}): DocsContent {
  const tally: Tally = { images: 0, drawings: 0, charts: 0, equations: 0, dropdowns: 0 };
  const flat = flattenTabs(document.tabs ?? []);
  const rendered = flat.map(({ tab, path }) => ({ path, ...renderTab(tab, tally) }));
  const sections = rendered.map(({ path, lines }) => {
    const body = trimBlankEdges(lines);
    return rendered.length > 1 ? [`=== Tab: ${path.join(" / ")} ===`, ...body] : body;
  });
  const lines = sections.flatMap((section, index) => (index === 0 ? section : ["", ...section]));
  const view = options.suggestionsView ?? "SUGGESTIONS_INLINE";
  const preview = view === "PREVIEW_WITHOUT_SUGGESTIONS";
  if (options.commentsRequested && preview) lines.push("", "[Comments]", "Not available with your access to this document.");
  else if (options.commentsRequested) {
    const comments = document.comments ?? [];
    const tabTitles = new Map<string, string>();
    for (const { tab, path } of flat) {
      for (const anchorId of Object.keys(tab.documentTab?.commentAnchors ?? {})) tabTitles.set(anchorId, path.join(" / "));
    }
    lines.push("", "[Comments]", ...(comments.length
      ? renderComments(comments, (thread) => (flat.length > 1 && thread.anchorId ? tabTitles.get(thread.anchorId) : undefined))
      : ["No comments."]));
  }
  const notes = [preview ? PREVIEW_NOTE : INLINE_NOTE, ...(preview && options.commentsRequested ? [COMMENTS_UNAVAILABLE_NOTE] : []), ...tallyNotes(tally)];
  return {
    documentId: document.documentId ?? "",
    title: document.title ?? "",
    ...(document.revisionId ? { revisionId: document.revisionId } : {}),
    suggestionsViewMode: view,
    text: trimBlankEdges(lines).join("\n"),
    tabs: rendered.map(({ view }) => view),
    notes,
  };
}
