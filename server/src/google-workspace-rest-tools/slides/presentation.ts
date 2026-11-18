import type { RestCommentThread } from "../documents-shared.js";

export const SLIDES_HOST = "slides.googleapis.com" as const;
export const SLIDES_BASE = "/v1/presentations";

export const presentationPath = (presentationId: string) => `${SLIDES_BASE}/${encodeURIComponent(presentationId)}`;

export interface RestSlidesLink {
  url?: string;
  relativeLink?: string;
  pageObjectId?: string;
  slideIndex?: number;
}

export interface RestTextElement {
  startIndex?: number;
  endIndex?: number;
  paragraphMarker?: { bullet?: { listId?: string; nestingLevel?: number; glyph?: string } };
  textRun?: { content?: string; style?: { link?: RestSlidesLink } };
  autoText?: { type?: string; content?: string; style?: { link?: RestSlidesLink } };
}

export interface RestTextContent {
  textElements?: RestTextElement[];
}

export interface RestTableCell {
  location?: { rowIndex?: number; columnIndex?: number };
  rowSpan?: number;
  columnSpan?: number;
  text?: RestTextContent;
}

export interface RestPageElement {
  objectId?: string;
  title?: string;
  description?: string;
  shape?: { shapeType?: string; text?: RestTextContent; placeholder?: { type?: string; index?: number } };
  table?: { rows?: number; columns?: number; tableRows?: Array<{ tableCells?: RestTableCell[] }> };
  image?: { contentUrl?: string; sourceUrl?: string };
  video?: { url?: string; source?: string; id?: string };
  line?: Record<string, unknown>;
  wordArt?: { renderedText?: string };
  sheetsChart?: { spreadsheetId?: string; chartId?: number };
  elementGroup?: { children?: RestPageElement[] };
  speakerSpotlight?: Record<string, unknown>;
}

export interface RestPage {
  objectId?: string;
  pageType?: string;
  pageElements?: RestPageElement[];
  slideProperties?: { layoutObjectId?: string; isSkipped?: boolean; notesPage?: RestPage };
  notesProperties?: { speakerNotesObjectId?: string };
  comments?: RestCommentThread[];
}

export interface RestPresentation {
  presentationId?: string;
  title?: string;
  revisionId?: string;
  slides?: RestPage[];
  layouts?: RestPage[];
  masters?: RestPage[];
  comments?: RestCommentThread[];
}

export interface RestBatchUpdateResponse {
  presentationId?: string;
  replies?: Array<Record<string, unknown>>;
  writeControl?: { requiredRevisionId?: string };
}
