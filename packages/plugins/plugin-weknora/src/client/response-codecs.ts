import { WeknoraPluginError } from "../errors.js";
import type {
  DocumentChunk,
  DocumentSummary,
  IngestResult,
  KnowledgeBase,
  SearchResult,
  UpstreamEnvelope,
  WikiPage,
  WikiPageSummary,
  WikiSearchResult,
} from "./types.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeknoraPluginError("contract", `${label} response data must be an object`, false);
  }
  return value as RecordValue;
}

function string(value: unknown, label: string, fallback = ""): string {
  if (typeof value === "string") return value;
  if (fallback) return fallback;
  throw new WeknoraPluginError("contract", `${label} is missing from the WeKnora response`, false);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(value: RecordValue, ...names: string[]): unknown {
  for (const name of names) if (value[name] !== undefined) return value[name];
  return undefined;
}

export function decodeEnvelope<T>(payload: unknown, label: string, decode: (data: unknown) => T): T {
  const envelope = record(payload, label) as UpstreamEnvelope<unknown>;
  if (typeof envelope.success !== "boolean") {
    throw new WeknoraPluginError("contract", `${label} response is missing success`, false);
  }
  if (!envelope.success) {
    const error = record(envelope.error ?? {}, `${label} error`);
    const message = optionalString(error.message) ?? optionalString(error.detail) ?? `WeKnora ${label} request failed`;
    throw new WeknoraPluginError("upstream", message, false);
  }
  return decode(envelope.data);
}

function decodeKnowledgeBase(value: unknown): KnowledgeBase {
  const item = record(value, "knowledge base");
  return {
    id: string(field(item, "id", "knowledge_base_id"), "knowledge base id"),
    name: string(field(item, "name", "title"), "knowledge base name"),
    type: optionalString(field(item, "type", "knowledge_base_type")),
    knowledgeCount: number(field(item, "knowledge_count", "knowledgeCount", "knowledge_num")),
    chunkCount: number(field(item, "chunk_count", "chunkCount", "chunk_num")),
    processingCount: number(field(item, "processing_count", "processingCount", "processing_num")),
  };
}

export function decodeKnowledgeBaseList(data: unknown): { knowledgeBases: KnowledgeBase[] } {
  const source = Array.isArray(data) ? data : record(data, "knowledge base list");
  const items = Array.isArray(source) ? source : array(field(source, "knowledge_bases", "knowledgeBases", "items", "results"));
  return { knowledgeBases: items.map((item) => decodeKnowledgeBase(item)) };
}

function decodeSearchResult(value: unknown): SearchResult {
  const item = record(value, "search result");
  return {
    knowledgeBaseId: optionalString(field(item, "knowledge_base_id", "knowledgeBaseId", "kb_id")),
    knowledgeId: string(field(item, "knowledge_id", "knowledgeId", "id"), "search result knowledge id"),
    title: string(field(item, "title", "name", "filename"), "search result title", "Untitled document"),
    filename: optionalString(field(item, "filename", "file_name")),
    source: optionalString(field(item, "source", "source_url", "url")),
    chunkIndex: number(field(item, "chunk_index", "chunkIndex", "index")),
    score: typeof field(item, "score", "similarity") === "number" ? field(item, "score", "similarity") as number : undefined,
    content: string(field(item, "content", "text", "chunk_content"), "search result content"),
    truncated: false,
  };
}

export function decodeSearch(data: unknown): { results: SearchResult[] } {
  const source = Array.isArray(data) ? data : record(data, "search");
  const items = Array.isArray(source) ? source : array(field(source, "results", "items", "matches"));
  return { results: items.map(decodeSearchResult) };
}

export function decodeDocument(data: unknown): { document: DocumentSummary; chunks?: DocumentChunk[]; total?: number } {
  const source = record(data, "document");
  const documentValue = field(source, "document", "knowledge", "item") ?? source;
  const document = record(documentValue, "document");
  const chunksValue = field(source, "chunks", "knowledge_chunks");
  const chunks = Array.isArray(chunksValue)
    ? chunksValue.map((value) => {
        const item = record(value, "document chunk");
        return {
          index: number(field(item, "index", "chunk_index", "chunkIndex")),
          content: string(field(item, "content", "text", "chunk_content"), "document chunk content"),
          truncated: false,
        } satisfies DocumentChunk;
      })
    : undefined;
  return {
    document: {
      id: string(field(document, "id", "knowledge_id"), "document id"),
      title: string(field(document, "title", "name", "filename"), "document title", "Untitled document"),
      summary: optionalString(field(document, "summary", "description")),
      source: optionalString(field(document, "source", "source_url", "url")),
      status: optionalString(field(document, "status", "processing_status")),
    },
    chunks,
    total: typeof field(source, "total", "total_count", "chunk_count") === "number" ? field(source, "total", "total_count", "chunk_count") as number : undefined,
  };
}

export function decodeChunks(data: unknown): { chunks: DocumentChunk[]; total?: number } {
  const source = Array.isArray(data) ? { chunks: data } : record(data, "chunks");
  const items = array(field(source, "chunks", "items", "results"));
  return {
    chunks: items.map((value) => {
      const item = record(value, "document chunk");
      return {
        index: number(field(item, "index", "chunk_index", "chunkIndex")),
        content: string(field(item, "content", "text", "chunk_content"), "document chunk content"),
        truncated: false,
      };
    }),
    total: typeof field(source, "total", "total_count", "chunk_count") === "number" ? field(source, "total", "total_count", "chunk_count") as number : undefined,
  };
}

function decodeWikiSummary(value: unknown): WikiPageSummary {
  const item = record(value, "wiki page");
  return {
    slug: string(field(item, "slug", "path", "page_slug"), "wiki page slug"),
    title: string(field(item, "title", "name"), "wiki page title", "Untitled page"),
    summary: optionalString(field(item, "summary", "description", "excerpt")),
    pageType: optionalString(field(item, "page_type", "pageType", "type")),
    status: optionalString(field(item, "status")),
    updatedAt: optionalString(field(item, "updated_at", "updatedAt")),
  };
}

export function decodeWikiPages(data: unknown): { pages: WikiPageSummary[]; total?: number } {
  const source = Array.isArray(data) ? { pages: data } : record(data, "wiki pages");
  const items = array(field(source, "pages", "items", "results"));
  return {
    pages: items.map(decodeWikiSummary),
    total: typeof field(source, "total", "total_count") === "number" ? field(source, "total", "total_count") as number : undefined,
  };
}

export function decodeWikiPage(data: unknown): { page: WikiPage } {
  const source = record(data, "wiki page");
  const page = record(field(source, "page", "item") ?? source, "wiki page");
  const summary = decodeWikiSummary(page);
  return {
    page: {
      ...summary,
      content: string(field(page, "content", "body", "markdown"), "wiki page content", ""),
      sourceRefs: Array.isArray(field(page, "source_refs", "sourceRefs", "sources")) ? field(page, "source_refs", "sourceRefs", "sources") as Array<string | Record<string, unknown>> : undefined,
      inLinks: Array.isArray(field(page, "in_links", "inLinks")) ? (field(page, "in_links", "inLinks") as unknown[]).filter((v): v is string => typeof v === "string") : undefined,
      outLinks: Array.isArray(field(page, "out_links", "outLinks")) ? (field(page, "out_links", "outLinks") as unknown[]).filter((v): v is string => typeof v === "string") : undefined,
    },
  };
}

export function decodeWikiSearch(data: unknown): { results: WikiSearchResult[] } {
  const source = Array.isArray(data) ? { results: data } : record(data, "wiki search");
  const items = array(field(source, "results", "items", "matches"));
  return {
    results: items.map((value) => {
      const item = record(value, "wiki search result");
      return {
        slug: string(field(item, "slug", "path", "page_slug"), "wiki search result slug"),
        title: string(field(item, "title", "name"), "wiki search result title", "Untitled page"),
        summary: optionalString(field(item, "summary", "description")),
        excerpt: optionalString(field(item, "excerpt", "content", "text")),
        score: typeof field(item, "score", "similarity") === "number" ? field(item, "score", "similarity") as number : undefined,
      };
    }),
  };
}

export function decodeIngest(data: unknown): IngestResult {
  const source = record(data, "ingest");
  const id = string(field(source, "id", "knowledge_id", "knowledgeId", "task_id", "taskId"), "ingest id");
  return {
    id,
    status: optionalString(field(source, "status", "processing_status")),
    taskId: optionalString(field(source, "task_id", "taskId")),
  };
}

export function decodeDiagnostics(data: unknown): { stats?: Record<string, unknown>; lintCounts?: Record<string, number>; issues?: Array<Record<string, unknown>> } {
  const source = record(data, "diagnostics");
  const lint = field(source, "lint_counts", "lintCounts", "counts");
  const lintCounts = typeof lint === "object" && lint !== null && !Array.isArray(lint)
    ? Object.fromEntries(Object.entries(lint as Record<string, unknown>).filter(([, value]) => typeof value === "number")) as Record<string, number>
    : undefined;
  const issuesValue = field(source, "issues", "findings");
  return {
    stats: typeof field(source, "stats", "wiki_stats") === "object" && field(source, "stats", "wiki_stats") !== null ? field(source, "stats", "wiki_stats") as Record<string, unknown> : undefined,
    lintCounts,
    issues: Array.isArray(issuesValue) ? issuesValue.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)) : undefined,
  };
}
