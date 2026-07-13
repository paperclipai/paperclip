const AGENT_LINK_PATTERN = /agent:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;
const NEXT_OWNER_LABEL_PATTERN =
  /(?:\*\*)?\bnext\s+owner(?:\s*\/\s*action)?(?:\*\*)?\s*[:：]\s*/gi;
const NEXT_OWNER_CLAUSE_BOUNDARY_PATTERN =
  /(?:[.!?;]\s+|\s+)(?:\*\*)?(?:canonical\s+stage|current\s+owner|return\s+owner|next\s+(?:action|wake\s+path)|residual\s+risk|recommended\s+(?:unblock|path)|alternative)(?:\*\*)?\s*[:：]/i;

const ROLE_REFERENCES = new Set(["ceo", "cto", "cmo", "cfo", "qa", "pm", "devops", "security"]);
const GENERIC_REFERENCES = new Set([
  "agent",
  "board",
  "company",
  "human",
  "manager",
  "me",
  "next",
  "none",
  "owner",
  "paperclip",
  "system",
  "team",
  "them",
  "unknown",
  "user",
]);

export type NextOwnerHandoffReference = {
  line: string;
  explicitAgentIds: string[];
  references: string[];
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function cleanReference(raw: string) {
  return raw
    .replace(/\[[^\]]+\]\(agent:\/\/[0-9a-f-]+\)/gi, "")
    .replace(/\[\[agent:\/\/[0-9a-f-]+\]\]/gi, "")
    .replace(/[`*#[\]{}<>]/g, " ")
    .replace(/\b(or|and|then|back|to|for|with|from|the|a|an)\b/gi, " ")
    .replace(/[^a-z0-9_ -]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitReferenceCandidates(raw: string) {
  const withoutLinks = raw
    .replace(AGENT_LINK_PATTERN, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$1")
    .replace(/\s+[—-]\s+.*$/, " ");

  return withoutLinks
    .split(/(?:\s+or\s+|\s+and\s+|[,;/()|]+)/i)
    .map(cleanReference)
    .filter((candidate) => {
      if (!candidate) return false;
      const normalized = candidate.toLowerCase().replace(/[\s-]+/g, "_");
      if (GENERIC_REFERENCES.has(normalized)) return false;
      return ROLE_REFERENCES.has(normalized) || /^[a-z][a-z0-9_ -]{1,80}$/i.test(candidate);
    });
}

export function extractNextOwnerHandoffReferences(body: string): NextOwnerHandoffReference[] {
  const handoffs: NextOwnerHandoffReference[] = [];
  for (const line of body.split(/\r?\n/)) {
    const labels = [...line.matchAll(NEXT_OWNER_LABEL_PATTERN)];
    for (const [index, label] of labels.entries()) {
      const start = (label.index ?? 0) + label[0].length;
      const end = labels[index + 1]?.index ?? line.length;
      const clause = line.slice(start, end);
      const boundaryIndex = clause.search(NEXT_OWNER_CLAUSE_BOUNDARY_PATTERN);
      const rawTarget = (boundaryIndex >= 0 ? clause.slice(0, boundaryIndex) : clause)
        .replace(/[.!?;]+\s*$/, "")
        .trim();
      if (!rawTarget) continue;

      const explicitAgentIds = unique([...rawTarget.matchAll(AGENT_LINK_PATTERN)].map((item) => item[1].toLowerCase()));
      handoffs.push({
        line: line.trim(),
        explicitAgentIds,
        references: explicitAgentIds.length > 0 ? [] : unique(splitReferenceCandidates(rawTarget)),
      });
    }
  }
  return handoffs;
}
