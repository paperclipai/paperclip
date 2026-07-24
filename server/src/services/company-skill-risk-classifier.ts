export type CompanySkillRiskTier = 0 | 1 | 2;

export type CompanySkillRiskRationale = {
  matchedRule: "money_tool_touch" | "write_scope" | "read_only_default";
  matchedSignals: string[];
  summary: string;
};

export type CompanySkillRiskClassification = {
  tier: CompanySkillRiskTier;
  rationale: CompanySkillRiskRationale;
};

export type CompanySkillRiskClassifierInput = {
  markdown: string;
  metadata: Record<string, unknown> | null;
  fileInventory: Array<{ path: string; kind?: string }>;
  categories: string[];
};

// Ordered by precedence: money-tool touch always wins regardless of other signals.
const MONEY_TOOL_KEYWORDS = [
  "pricing", "price", "invoice", "invoicing", "payment", "pay ", "billing", "bill ",
  "charge", "refund", "checkout", "stripe", "quote", "quoting", "margin", "payout",
  "dispatch payment", "wire transfer", "purchase order", "subscription", "revenue",
  "cost basis", "fee ", "commission",
];

const WRITE_SCOPE_KEYWORDS = [
  "write", "writes", "writing", "create a", "creates a", "update the", "updates the",
  "delete", "deletes", "insert", "inserts", "save ", "saves ", "commit", "push",
  "publish", "post a comment", "posts a comment", "file write", "db write",
  "database write", "record", "log ", "logs ",
];

const WRITE_HTTP_METHOD_PATTERN = /\b(POST|PUT|PATCH|DELETE)\b/;
const SQL_WRITE_PATTERN = /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i;

function findMatches(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();
  return needles.filter((needle) => lower.includes(needle.toLowerCase()));
}

export function classifySkillRisk(input: CompanySkillRiskClassifierInput): CompanySkillRiskClassification {
  const corpus = [
    input.markdown,
    ...input.categories,
    ...input.fileInventory.map((entry) => entry.path),
    input.metadata ? JSON.stringify(input.metadata) : "",
  ].join("\n");

  const moneyMatches = findMatches(corpus, MONEY_TOOL_KEYWORDS);
  if (moneyMatches.length > 0) {
    return {
      tier: 2,
      rationale: {
        matchedRule: "money_tool_touch",
        matchedSignals: moneyMatches,
        summary: `Money-tool keyword(s) detected: ${moneyMatches.join(", ")}`,
      },
    };
  }

  const writeKeywordMatches = findMatches(corpus, WRITE_SCOPE_KEYWORDS);
  const httpWriteMatch = WRITE_HTTP_METHOD_PATTERN.exec(corpus);
  const sqlWriteMatch = SQL_WRITE_PATTERN.exec(corpus);
  const writeSignals = [
    ...writeKeywordMatches,
    ...(httpWriteMatch ? [httpWriteMatch[0]] : []),
    ...(sqlWriteMatch ? [sqlWriteMatch[0]] : []),
  ];
  if (writeSignals.length > 0) {
    return {
      tier: 1,
      rationale: {
        matchedRule: "write_scope",
        matchedSignals: writeSignals,
        summary: `Write-scope signal(s) detected: ${writeSignals.join(", ")}`,
      },
    };
  }

  return {
    tier: 0,
    rationale: {
      matchedRule: "read_only_default",
      matchedSignals: [],
      summary: "No money-tool or write-scope signals detected; treated as read-only/informational.",
    },
  };
}
