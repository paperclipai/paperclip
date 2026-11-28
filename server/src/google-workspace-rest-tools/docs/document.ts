import type { RestCommentThread } from "../documents-shared.js";

export const DOCS_HOST = "docs.googleapis.com" as const;
export const DOCS_BASE = "/v1/documents";

export const documentPath = (documentId: string) => `${DOCS_BASE}/${encodeURIComponent(documentId)}`;

export interface RestDocsLink {
  url?: string;
  tabId?: string;
  headingId?: string;
  bookmarkId?: string;
  heading?: { id?: string; tabId?: string };
  bookmark?: { id?: string; tabId?: string };
}

export interface RestSuggestible {
  suggestedInsertionIds?: string[];
  suggestedDeletionIds?: string[];
}

export interface RestParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: RestSuggestible & { content?: string; textStyle?: { link?: RestDocsLink } };
  autoText?: RestSuggestible & { type?: string };
  pageBreak?: RestSuggestible;
  columnBreak?: RestSuggestible;
  footnoteReference?: RestSuggestible & { footnoteId?: string; footnoteNumber?: string };
  horizontalRule?: RestSuggestible;
  equation?: RestSuggestible;
  inlineObjectElement?: RestSuggestible & { inlineObjectId?: string };
  person?: RestSuggestible & { personProperties?: { name?: string; email?: string } };
  richLink?: RestSuggestible & { richLinkProperties?: { title?: string; uri?: string } };
  dateElement?: RestSuggestible & { dateElementProperties?: { displayText?: string } };
  dropdown?: RestSuggestible;
}

export interface RestParagraph {
  elements?: RestParagraphElement[];
  paragraphStyle?: { namedStyleType?: string; headingId?: string };
  bullet?: { listId?: string; nestingLevel?: number };
  positionedObjectIds?: string[];
}

export interface RestTableCell {
  startIndex?: number;
  endIndex?: number;
  content?: RestStructuralElement[];
  tableCellStyle?: { rowSpan?: number; columnSpan?: number };
}

export interface RestTable {
  rows?: number;
  columns?: number;
  tableRows?: Array<{ startIndex?: number; endIndex?: number; tableCells?: RestTableCell[] }>;
}

export interface RestStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: RestParagraph;
  table?: RestTable;
  sectionBreak?: Record<string, unknown>;
  tableOfContents?: { content?: RestStructuralElement[] };
}

export interface RestSegment {
  headerId?: string;
  footerId?: string;
  footnoteId?: string;
  content?: RestStructuralElement[];
}

export interface RestNestingLevel {
  glyphType?: string;
  glyphSymbol?: string;
  glyphFormat?: string;
  startNumber?: number;
}

export interface RestEmbeddedObject {
  title?: string;
  description?: string;
  imageProperties?: Record<string, unknown>;
  embeddedDrawingProperties?: Record<string, unknown>;
  linkedContentReference?: { sheetsChartReference?: Record<string, unknown> };
}

export interface RestDocumentStyle {
  defaultHeaderId?: string;
  firstPageHeaderId?: string;
  evenPageHeaderId?: string;
  defaultFooterId?: string;
  firstPageFooterId?: string;
  evenPageFooterId?: string;
}

export interface RestDocumentTab {
  body?: { content?: RestStructuralElement[] };
  headers?: Record<string, RestSegment>;
  footers?: Record<string, RestSegment>;
  footnotes?: Record<string, RestSegment>;
  documentStyle?: RestDocumentStyle;
  lists?: Record<string, { listProperties?: { nestingLevels?: RestNestingLevel[] } }>;
  inlineObjects?: Record<string, { inlineObjectProperties?: { embeddedObject?: RestEmbeddedObject } }>;
  positionedObjects?: Record<string, { positionedObjectProperties?: { embeddedObject?: RestEmbeddedObject } }>;
  commentAnchors?: Record<string, { anchorId?: string; ranges?: Array<{ segmentId?: string; startIndex?: number; endIndex?: number; tabId?: string }> }>;
}

export interface RestTab {
  tabProperties?: { tabId?: string; title?: string; parentTabId?: string; index?: number; nestingLevel?: number };
  documentTab?: RestDocumentTab;
  childTabs?: RestTab[];
}

export interface RestDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  tabs?: RestTab[];
  comments?: RestCommentThread[];
}

export interface RestBatchUpdateResponse {
  documentId?: string;
  replies?: Array<Record<string, unknown>>;
  writeControl?: { requiredRevisionId?: string; targetRevisionId?: string };
}
