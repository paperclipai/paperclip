import type { QBankPartnerItem } from "@paperclipai/shared";

export const HLT_PARTNER_QBANK_MCP_ENDPOINT = "https://api.hltcorp.com/api/partner/v1/mcp";

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

  const response = await fetch(input.endpointUrl ?? HLT_PARTNER_QBANK_MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mcp-token": apiKey,
    },
    body: JSON.stringify({
      action: "get_question",
      app_id: appId,
      id: questionId,
    }),
  });

  if (!response.ok) {
    throw new Error(`HLT Partner API returned ${response.status}`);
  }

  const payload = await response.json() as unknown;
  const item = extractQBankItem(payload);
  if (!item) {
    throw new Error("HLT Partner API response did not include a QBank item");
  }
  return item;
}

function extractQBankItem(payload: unknown): QBankPartnerItem | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.item,
    record.question,
    record.data,
    record.result,
  ];
  for (const candidate of candidates) {
    if (isQBankPartnerItem(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      if (isQBankPartnerItem(nested.item)) return nested.item;
      if (isQBankPartnerItem(nested.question)) return nested.question;
    }
  }
  return isQBankPartnerItem(payload) ? payload : null;
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
