import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { QBankPartnerItem } from "@paperclipai/shared";

export const HLT_PARTNER_QBANK_MCP_ENDPOINT = "https://api.hltcorp.com/api/partner/v1/mcp";

const GET_QUESTION_TOOL_CANDIDATES = [
  "get_question",
  "show_flashcard",
  "questions.get",
  "qbank.get",
  "question_bank.get",
  "partner.get_question",
  "hlt_partner.get_question",
];

export type FetchPartnerQBankQuestionInput = {
  appId: number | string;
  questionId: number | string;
  apiKey?: string | null;
  endpointUrl?: string;
};

export function getConfiguredPartnerApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HLT_PARTNER_API_KEY
    ?? env.HLT_PARTNER_MCP_TOKEN
    ?? env.PARTNER_API_KEY
    ?? env.QBANK_PARTNER_API_KEY;
}

export async function fetchPartnerQBankQuestion(input: FetchPartnerQBankQuestionInput): Promise<QBankPartnerItem> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error("HLT Partner API token is not configured");
  }

  const appId = Number(input.appId);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error("QBank app ID must be a positive integer");
  }

  const questionId = String(input.questionId).trim();
  if (!questionId) {
    throw new Error("QBank question ID is required");
  }

  const endpoint = input.endpointUrl ?? HLT_PARTNER_QBANK_MCP_ENDPOINT;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { "x-mcp-token": apiKey },
    },
  });
  const client = new Client({ name: "paperclip-hlt-partner-qbank", version: "0.1.0" });

  await client.connect(transport);
  try {
    const tools = await client.listTools({});
    const toolName = pickGetQuestionTool(
      Array.isArray(tools.tools)
        ? tools.tools.flatMap((tool) => typeof tool.name === "string" ? [tool.name] : [])
        : [],
    );
    const result = await client.callTool({
      name: toolName,
      arguments: {
        app_id: appId,
        id: questionId,
      },
    });
    const item = extractQBankItem(result);
    if (!item) {
      throw new Error("HLT Partner API response did not include a QBank item");
    }
    return item;
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

function pickGetQuestionTool(toolNames: string[]): string {
  const normalizedCandidates = GET_QUESTION_TOOL_CANDIDATES.map(normalizeToolName);
  for (const candidate of normalizedCandidates) {
    const exact = toolNames.find((toolName) => normalizeToolName(toolName) === candidate);
    if (exact) return exact;
  }
  for (const candidate of normalizedCandidates) {
    const suffix = toolNames.find((toolName) => normalizeToolName(toolName).endsWith(candidate));
    if (suffix) return suffix;
  }
  throw new Error("HLT Partner MCP did not expose a get_question tool");
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
    record.data,
    record.result,
    record.structuredContent,
    ...parsedContent,
  ];
  for (const candidate of candidates) {
    const item = extractQBankItemCandidate(candidate);
    if (item) return item;
  }
  return isQBankPartnerItem(payload) ? payload : null;
}

function extractQBankItemCandidate(candidate: unknown): QBankPartnerItem | null {
  if (isQBankPartnerItem(candidate)) return candidate;
  if (!candidate || typeof candidate !== "object") return null;
  const nested = candidate as Record<string, unknown>;
  if (isQBankPartnerItem(nested.item)) return nested.item;
  if (isQBankPartnerItem(nested.question)) return nested.question;
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
