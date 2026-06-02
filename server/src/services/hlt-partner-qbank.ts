import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { QBankPartnerItem } from "@paperclipai/shared";

export const HLT_PARTNER_QBANK_MCP_ENDPOINT = "https://api.hltcorp.com/api/partner/v1/mcp";

const TOOL_CANDIDATES: Record<string, string[]> = {
  getQuestion: [
    "get_question",
    "show_flashcard",
    "questions.get",
    "qbank.get",
    "question_bank.get",
    "partner.get_question",
    "hlt_partner.get_question",
  ],
  listQuestions: [
    "list_flashcards",
    "search_questions",
    "questions.search",
    "qbank.search",
    "question_bank.search",
  ],
  listDiscussions: [
    "list_discussions",
    "discussions.list",
    "partner.list_discussions",
  ],
};

export type FetchPartnerQBankQuestionInput = {
  appId: number | string;
  questionId: number | string;
  apiKey?: string | null;
  endpointUrl?: string;
  includeDiscussions?: boolean;
  discussionLimit?: number;
};

export type SearchPartnerQBankInput = {
  appId: number | string;
  query: string;
  apiKey?: string | null;
  endpointUrl?: string;
  limit?: number;
  scanLimit?: number;
  categoryId?: number | string | null;
  includeDiscussions?: boolean;
};

export type QBankSearchResult = {
  item: QBankPartnerItem;
  score: number;
  matchedFields: string[];
  sourceRef: string;
};

export type QBankDiscussionRecord = Record<string, unknown>;

export function getConfiguredPartnerApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HLT_PARTNER_API_KEY
    ?? env.HLT_PARTNER_MCP_TOKEN
    ?? env.PARTNER_API_KEY
    ?? env.QBANK_PARTNER_API_KEY;
}

export async function fetchPartnerQBankQuestion(input: FetchPartnerQBankQuestionInput): Promise<QBankPartnerItem> {
  const apiKey = requireApiKey(input.apiKey);
  const appId = normalizePositiveInteger(input.appId, "QBank app ID");
  const questionId = normalizeQuestionId(input.questionId);

  const payload = await callPartnerTool({
    apiKey,
    endpointUrl: input.endpointUrl,
    kind: "getQuestion",
    arguments: { app_id: appId, id: Number(questionId) || questionId },
  });
  const item = extractQBankItem(payload);
  if (!item) {
    throw new Error("HLT Partner API response did not include a QBank item");
  }

  if (input.includeDiscussions !== false) {
    const discussions = await listPartnerQBankDiscussions({
      appId,
      questionId,
      apiKey,
      endpointUrl: input.endpointUrl,
      limit: input.discussionLimit ?? 25,
    });
    if (discussions.length) {
      return { ...item, discussion_threads: discussions } as QBankPartnerItem;
    }
  }
  return item;
}

export async function searchPartnerQBankQuestions(input: SearchPartnerQBankInput): Promise<QBankSearchResult[]> {
  const apiKey = requireApiKey(input.apiKey);
  const appId = normalizePositiveInteger(input.appId, "QBank app ID");
  const query = input.query.trim();
  if (!query) throw new Error("QBank search query is required");
  const limit = clampInteger(input.limit ?? 8, 1, 25);
  const scanLimit = clampInteger(input.scanLimit ?? 80, limit, 250);

  const idsPayload = await callPartnerTool({
    apiKey,
    endpointUrl: input.endpointUrl,
    kind: "listQuestions",
    arguments: {
      app_id: appId,
      q: query,
      limit: scanLimit,
      ...(input.categoryId ? { category_id: normalizePositiveInteger(input.categoryId, "QBank category ID") } : {}),
    },
  });
  const ids = extractFlashcardIds(idsPayload).slice(0, scanLimit);
  const results: QBankSearchResult[] = [];

  for (const id of ids) {
    try {
      const item = await fetchPartnerQBankQuestion({
        appId,
        questionId: id,
        apiKey,
        endpointUrl: input.endpointUrl,
        includeDiscussions: input.includeDiscussions === true,
        discussionLimit: 10,
      });
      const match = scoreQBankItem(item, query);
      if (match.score > 0) {
        results.push({
          item,
          score: match.score,
          matchedFields: match.matchedFields,
          sourceRef: `qbank:app-${appId}/question-${item.id}`,
        });
      }
    } catch {
      // Keep search resilient: one inaccessible or malformed item should not fail the whole search.
    }
    if (results.length >= limit * 3) break;
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function listPartnerQBankDiscussions(input: {
  appId: number;
  questionId: string;
  apiKey: string;
  endpointUrl?: string;
  limit: number;
}): Promise<QBankDiscussionRecord[]> {
  try {
    const payload = await callPartnerTool({
      apiKey: input.apiKey,
      endpointUrl: input.endpointUrl,
      kind: "listDiscussions",
      arguments: {
        app_id: input.appId,
        resource_type: "flashcard",
        resource_id: Number(input.questionId) || input.questionId,
        limit: clampInteger(input.limit, 1, 100),
        offset: 0,
      },
    });
    return extractRecords(payload);
  } catch {
    return [];
  }
}

async function callPartnerTool(input: {
  apiKey: string;
  kind: keyof typeof TOOL_CANDIDATES;
  arguments: Record<string, unknown>;
  endpointUrl?: string;
}): Promise<unknown> {
  const endpoint = input.endpointUrl ?? HLT_PARTNER_QBANK_MCP_ENDPOINT;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { "x-mcp-token": input.apiKey },
    },
  });
  const client = new Client({ name: "paperclip-hlt-partner-qbank", version: "0.1.0" });

  await client.connect(transport);
  try {
    const tools = await client.listTools({});
    const toolName = pickTool(
      Array.isArray(tools.tools)
        ? tools.tools.flatMap((tool) => typeof tool.name === "string" ? [tool.name] : [])
        : [],
      input.kind,
    );
    return client.callTool({
      name: toolName,
      arguments: input.arguments,
    });
  } finally {
    await transport.close().catch(() => {
      // Best-effort close only.
    });
  }
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pickTool(toolNames: string[], kind: keyof typeof TOOL_CANDIDATES): string {
  const normalizedCandidates = TOOL_CANDIDATES[kind].map(normalizeToolName);
  for (const candidate of normalizedCandidates) {
    const exact = toolNames.find((toolName) => normalizeToolName(toolName) === candidate);
    if (exact) return exact;
  }
  for (const candidate of normalizedCandidates) {
    const suffix = toolNames.find((toolName) => normalizeToolName(toolName).endsWith(candidate));
    if (suffix) return suffix;
  }
  throw new Error(`HLT Partner MCP did not expose a ${kind} tool`);
}

function extractQBankItem(payload: unknown): QBankPartnerItem | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const contentText = Array.isArray(record.content)
    ? record.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      return typeof row.text === "string" ? [row.text] : [];
    })
    : [];
  const parsedContent = contentText.flatMap((text) => {
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [];
    }
  });

  const candidates = [
    record.item,
    record.question,
    record.flashcard,
    record.data,
    record.result,
    record.structuredContent,
    ...parsedContent,
    payload,
  ];
  for (const candidate of candidates) {
    const item = extractQBankItemCandidate(candidate);
    if (item) return item;
  }
  return null;
}

function extractFlashcardIds(payload: unknown): Array<number | string> {
  const records = extractRecords(payload);
  if (records.length) {
    return records.flatMap((record) => {
      const id = record.id ?? record.flashcard_id ?? record.asset_id;
      return typeof id === "number" || typeof id === "string" ? [id] : [];
    });
  }
  const record = asRecord(payload);
  const candidates = [record?.ids, record?.flashcard_ids, record?.data, record?.result, payload];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.flatMap((entry) => {
        if (typeof entry === "number" || typeof entry === "string") return [entry];
        const id = asRecord(entry)?.id;
        return typeof id === "number" || typeof id === "string" ? [id] : [];
      });
    }
  }
  return [];
}

function extractRecords(payload: unknown): QBankDiscussionRecord[] {
  const record = asRecord(payload);
  const contentText = Array.isArray(record?.content)
    ? record.content.flatMap((entry) => {
      const text = asRecord(entry)?.text;
      if (typeof text !== "string" || !text.trim()) return [];
      try {
        return [JSON.parse(text) as unknown];
      } catch {
        return [];
      }
    })
    : [];
  const candidates = [record?.records, record?.items, record?.data, record?.result, ...contentText, payload];
  for (const candidate of candidates) {
    const candidateRecord = asRecord(candidate);
    const nested = [candidateRecord?.records, candidateRecord?.items, candidateRecord?.data, candidateRecord?.result];
    for (const value of [candidate, ...nested]) {
      if (Array.isArray(value)) return value.filter((entry): entry is QBankDiscussionRecord => Boolean(asRecord(entry)));
    }
  }
  return [];
}

function scoreQBankItem(item: QBankPartnerItem, query: string): { score: number; matchedFields: string[] } {
  const terms = tokenize(query);
  const fields: Array<[string, string | undefined | null, number]> = [
    ["question", item.question, 8],
    ["rationale", item.rationale, 5],
    ["key_takeaway", item.key_takeaway, 4],
    ["draft_question", item.draft_question, 6],
    ["draft_rationale", item.draft_rationale, 4],
    ["draft_key_takeaway", item.draft_key_takeaway, 3],
    ["answers", (item.answers ?? []).map((answer) => `${answer.text ?? ""} ${answer.rationale ?? ""} ${answer.raw_rationale ?? ""}`).join(" "), 3],
    ["categories", (item.categories ?? []).map((category) => category.name ?? "").join(" "), 2],
  ];
  let score = 0;
  const matchedFields = new Set<string>();
  for (const [name, value, weight] of fields) {
    const haystack = stripHtml(value ?? "").toLowerCase();
    if (!haystack) continue;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += weight;
        matchedFields.add(name);
      }
    }
    if (haystack.includes(query.toLowerCase())) {
      score += weight * 2;
      matchedFields.add(name);
    }
  }
  return { score, matchedFields: [...matchedFields] };
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3))];
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;?/gi, " ").replace(/\s+/g, " ").trim();
}

function requireApiKey(value: string | null | undefined): string {
  const apiKey = value?.trim();
  if (!apiKey) throw new Error("HLT Partner API token is not configured");
  return apiKey;
}

function normalizePositiveInteger(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function normalizeQuestionId(value: number | string): string {
  const questionId = String(value).trim();
  if (!questionId) throw new Error("QBank question ID is required");
  return questionId;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractQBankItemCandidate(candidate: unknown): QBankPartnerItem | null {
  if (isQBankPartnerItem(candidate)) return candidate;
  if (!candidate || typeof candidate !== "object") return null;
  const nested = candidate as Record<string, unknown>;
  if (isQBankPartnerItem(nested.item)) return nested.item;
  if (isQBankPartnerItem(nested.question)) return nested.question;
  if (isQBankPartnerItem(nested.flashcard)) return nested.flashcard;
  if (isQBankPartnerItem(nested.data)) return nested.data;
  if (isQBankPartnerItem(nested.result)) return nested.result;
  return null;
}

function isQBankPartnerItem(value: unknown): value is QBankPartnerItem {
  return Boolean(
    value
    && typeof value === "object"
    && "id" in value
    && (
      typeof (value as { id?: unknown }).id === "number"
      || typeof (value as { id?: unknown }).id === "string"
    ),
  );
}
