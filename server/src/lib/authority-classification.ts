export type AuthorityTier = "T1" | "T2" | "T2A" | "T3";

export interface T3Triggers {
  securitySensitive: boolean | null;
  realWorldCost: boolean | null;
  environmentIntegrityRisk: boolean | null;
  publicReputationalAction: boolean | null;
  strategicFork: boolean | null;
}

export interface AuthorityClassificationBlock {
  tier: AuthorityTier | null;
  t3Triggers: T3Triggers;
  approvalRequired: boolean | null;
  approvalId: string | null;
  decisionPacketRequired: boolean | null;
}

export interface ClassificationParseResult {
  found: boolean;
  block: AuthorityClassificationBlock | null;
  inconsistencies: string[];
}

const TIER_VALUES = new Set<AuthorityTier>(["T1", "T2", "T2A", "T3"]);
const PLACEHOLDER_APPROVAL_ID_PATTERNS = [
  /^\s*required if/i,
  /^\s*\(.*\)\s*$/,
  /^\s*n\/a\s*$/i,
  /^\s*-\s*$/,
  /^\s*$/,
];

function parseBooleanField(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

function isPlaceholderApprovalId(value: string): boolean {
  return PLACEHOLDER_APPROVAL_ID_PATTERNS.some((p) => p.test(value));
}

function extractClassificationCodeBlock(description: string): string | null {
  // Match ```markdown ... ``` or ``` ... ``` blocks containing "Authority Classification:"
  const fencePattern = /```(?:markdown)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(description)) !== null) {
    const content = match[1];
    if (/^authority classification:/im.test(content)) {
      return content;
    }
  }
  // Also check for inline (unfenced) classification block at description root
  if (/^authority classification:/im.test(description)) {
    return description;
  }
  return null;
}

function parseKeyValue(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split("\n");
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  for (const line of lines) {
    // Key line: "Key:" with optional value on same line or next line
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9 /()-]*):\s*(.*)$/);
    if (keyMatch) {
      if (currentKey !== null) {
        map.set(currentKey, currentValue.join("\n").trim());
      }
      currentKey = keyMatch[1].trim().toLowerCase();
      currentValue = keyMatch[2] ? [keyMatch[2].trim()] : [];
    } else if (currentKey !== null && line.trim() && !line.startsWith("#")) {
      currentValue.push(line.trim());
    }
  }
  if (currentKey !== null) {
    map.set(currentKey, currentValue.join("\n").trim());
  }
  return map;
}

function parseT3TriggerLine(text: string, label: string): boolean | null {
  const pattern = new RegExp(`-\\s*${label}\\s*:\\s*(yes|no)`, "i");
  const match = text.match(pattern);
  if (!match) return null;
  return parseBooleanField(match[1]);
}

export function parseClassificationBlock(description: string): ClassificationParseResult {
  const blockText = extractClassificationCodeBlock(description);
  if (!blockText) {
    return { found: false, block: null, inconsistencies: [] };
  }

  const kv = parseKeyValue(blockText);

  const tierRaw = kv.get("authority classification") ?? null;
  const tier: AuthorityTier | null = tierRaw && TIER_VALUES.has(tierRaw.toUpperCase() as AuthorityTier)
    ? (tierRaw.toUpperCase() as AuthorityTier)
    : null;

  const triggerSectionRaw = kv.get("t3 trigger check") ?? blockText;

  const t3Triggers: T3Triggers = {
    securitySensitive: parseT3TriggerLine(triggerSectionRaw, "Security-sensitive"),
    realWorldCost: parseT3TriggerLine(triggerSectionRaw, "Real-world cost"),
    environmentIntegrityRisk: parseT3TriggerLine(triggerSectionRaw, "Environment integrity risk"),
    publicReputationalAction: parseT3TriggerLine(triggerSectionRaw, "Public/reputational action"),
    strategicFork: parseT3TriggerLine(triggerSectionRaw, "Strategic fork"),
  };

  const approvalRequiredRaw = kv.get("approval required") ?? null;
  const approvalRequired = approvalRequiredRaw ? parseBooleanField(approvalRequiredRaw) : null;

  const approvalIdRaw = kv.get("approval id") ?? null;
  const approvalId =
    approvalIdRaw && !isPlaceholderApprovalId(approvalIdRaw) ? approvalIdRaw.trim() : null;

  const decisionPacketRaw = kv.get("decision packet required") ?? null;
  const decisionPacketRequired = decisionPacketRaw ? parseBooleanField(decisionPacketRaw) : null;

  const block: AuthorityClassificationBlock = {
    tier,
    t3Triggers,
    approvalRequired,
    approvalId,
    decisionPacketRequired,
  };

  const inconsistencies = detectInconsistencies(block);

  return { found: true, block, inconsistencies };
}

export function detectInconsistencies(block: AuthorityClassificationBlock): string[] {
  const issues: string[] = [];

  if (!block.tier) {
    issues.push("Authority tier is missing or unrecognized (expected T1, T2, T2A, or T3)");
  }

  const anyT3TriggerActive = Object.values(block.t3Triggers).some((v) => v === true);
  const allTriggersNull = Object.values(block.t3Triggers).every((v) => v === null);

  if (allTriggersNull) {
    issues.push("T3 trigger check is missing or unparseable");
  }

  if (anyT3TriggerActive && block.tier && block.tier !== "T3") {
    issues.push(
      `One or more T3 triggers are active (Yes) but tier is classified as ${block.tier} — should be T3`,
    );
  }

  if (!anyT3TriggerActive && !allTriggersNull && block.tier === "T3") {
    issues.push("Tier is T3 but no T3 triggers are active — check trigger values");
  }

  if (block.tier === "T3" && block.approvalRequired !== true) {
    issues.push("T3 tier requires Approval Required: Yes");
  }

  if (block.tier === "T3" && block.approvalRequired === true && !block.approvalId) {
    issues.push("Approval Required is Yes but Approval ID is missing or placeholder");
  }

  if (block.approvalRequired === false && block.approvalId) {
    issues.push("Approval Required is No but an Approval ID is present — verify intent");
  }

  return issues;
}

export function isT3Issue(result: ClassificationParseResult): boolean {
  return result.found && result.block?.tier === "T3";
}

export function hasGrantedApprovalId(result: ClassificationParseResult): boolean {
  return result.found && !!result.block?.approvalId;
}
