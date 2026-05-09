import type { AutonomyEvidenceType, AutonomyJsonValue, AutonomySourceType } from "@paperclipai/shared";
import type { AutonomyRunRef, RecordEvidenceInput } from "./types.js";

export type EvidenceExtractionSourceKind = "run" | "comment" | "work_product" | "log";

export interface EvidenceExtractionInput extends AutonomyRunRef {
  text: string;
  sourceKind: EvidenceExtractionSourceKind;
  sourceId?: string | null;
}

export interface ExtractedEvidenceInput extends RecordEvidenceInput {
  payload: Record<string, AutonomyJsonValue>;
}

const SOURCE_TYPE_BY_KIND: Record<EvidenceExtractionSourceKind, AutonomySourceType> = {
  run: "heartbeat_run_event",
  comment: "issue",
  work_product: "external",
  log: "heartbeat_run_event",
};

const COMMIT_CONTEXT_RE = /\b(?:commit|committed|sha|hash|revision|rev)\s*(?:=|:|#|-|is|at)?\s*`?([a-f0-9]{7,40})`?\b/gi;
const FULL_COMMIT_RE = /\b([a-f0-9]{40})\b/gi;
const URL_RE = /https?:\/\/[^\s<>)\]}"']+/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i;
const IMAGE_PATH_RE = /(?:^|[\s:(\[])(`?(?:\.?\.?\/?|~\/|file:\/\/)?[A-Za-z0-9_.~@/+\-]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^\s`)]*)?`?)/gim;
const MARKDOWN_DOC_LINK_RE = /\[([^\]\n]{1,120})\]\(([^)]+\.(?:md|mdx|pdf|txt|docx?)(?:#[^)]+)?)\)/gi;
const DOC_PATH_RE = /(?:^|[\s:(\[])(`?(?:\.?\.?\/?|~\/|file:\/\/)?[A-Za-z0-9_.~@/+\-]+\.(?:md|mdx|pdf|txt|docx?)(?:#[^\s`)]*)?`?)/gim;
const WORK_PRODUCT_RE = /\b(?:work product|artifacts?|deliverable|output)\s*(?:=|:|-)\s*`?([^`\n]+?)`?\s*$/gim;
const APPROVAL_DECISION_RE = /\b(?:approval|approved|rejected|denied)\b[^\n]*(?:\b(approved|rejected|denied)\b|\bby\s+([A-Z][\w .@-]{1,80}))/gim;
const BLOCKER_RE = /\bblocked\s+by\s+([^:\n.;]{2,80})\s*(?::|-|;|,)\s*(?:action\s*(?::|-)?\s*)?([^\n]{3,240})/gim;
const OWNER_ACTION_RE = /\bblocker\b[^\n]*\bowner\s*(?::|-)?\s*([^;\n,]{2,80})[^\n]*\baction\s*(?::|-)?\s*([^\n]{3,240})/gim;
const RESULT_RE = /\b(pass(?:ed|ing)?|success(?:ful)?|succeeded|green|fail(?:ed|ing)?|error|exit(?:ed)?\s+(?:code\s+)?\d+|0\s+failed)\b/i;
const TEST_COMMAND_RE = /\b((?:pnpm|npm|yarn|bun|npx)\s+[^\n`]*(?:test|vitest|jest)[^\n`]*|vitest\b[^\n`]*|jest\b[^\n`]*|pytest\b[^\n`]*|go\s+test\b[^\n`]*|cargo\s+test\b[^\n`]*|xcodebuild\b[^\n`]*\btest\b[^\n`]*)/i;
const BUILD_COMMAND_RE = /\b((?:pnpm|npm|yarn|bun)\s+[^\n`]*build[^\n`]*|(?:npx\s+)?(?:vite|tsc)\b[^\n`]*|go\s+build\b[^\n`]*|cargo\s+build\b[^\n`]*|xcodebuild\b(?:(?!\btest\b)[^\n`])*)/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripWrapping(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").replace(/[),.;]+$/g, "").trim();
}

function sourceTypeFor(input: EvidenceExtractionInput): AutonomySourceType {
  return SOURCE_TYPE_BY_KIND[input.sourceKind];
}

function baseEvidence(
  input: EvidenceExtractionInput,
  type: AutonomyEvidenceType,
  title: string,
  payload: Record<string, AutonomyJsonValue>,
  options: { summary?: string | null; uri?: string | null } = {},
): ExtractedEvidenceInput {
  return {
    companyId: input.companyId,
    runId: input.runId ?? null,
    issueId: input.issueId ?? null,
    agentId: input.agentId ?? null,
    laneKey: input.laneKey ?? null,
    type,
    title,
    summary: options.summary ?? null,
    uri: options.uri ?? null,
    sourceType: sourceTypeFor(input),
    sourceId: input.sourceId ?? input.runId ?? input.issueId ?? null,
    payload: {
      ...payload,
      extractedFrom: input.sourceKind,
      extractorVersion: "evidence-extractors.regex.v1",
      validationState: "pending",
    },
  };
}

function pushUnique(items: ExtractedEvidenceInput[], item: ExtractedEvidenceInput, seen: Set<string>): void {
  const key = [item.type, item.uri ?? "", item.title].join("\u0000");
  if (seen.has(key)) return;
  seen.add(key);
  items.push(item);
}

function lineWindow(lines: string[], index: number, radius = 2): string {
  return lines.slice(index, Math.min(lines.length, index + radius + 1)).join("\n");
}

function extractCommandEvidence(input: EvidenceExtractionInput, seen: Set<string>, items: ExtractedEvidenceInput[]): void {
  const lines = input.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripWrapping(lines[index] ?? "").replace(/^[$>]\s*/, "");
    const window = lineWindow(lines, index);
    const testCommand = line.match(TEST_COMMAND_RE)?.[1];
    if (testCommand && RESULT_RE.test(window)) {
      const result = window.match(RESULT_RE)?.[0] ?? null;
      pushUnique(
        items,
        baseEvidence(input, "test_run", `Candidate test run: ${normalizeWhitespace(testCommand)}`, {
          command: normalizeWhitespace(testCommand),
          claimedResult: result,
          matchedText: normalizeWhitespace(window),
        }),
        seen,
      );
    }

    const buildCommand = line.match(BUILD_COMMAND_RE)?.[1];
    if (buildCommand && RESULT_RE.test(window)) {
      const result = window.match(RESULT_RE)?.[0] ?? null;
      pushUnique(
        items,
        baseEvidence(input, "build", `Candidate build: ${normalizeWhitespace(buildCommand)}`, {
          command: normalizeWhitespace(buildCommand),
          claimedResult: result,
          matchedText: normalizeWhitespace(window),
        }),
        seen,
      );
    }
  }
}

export function extractEvidenceCandidates(input: EvidenceExtractionInput): ExtractedEvidenceInput[] {
  if (!input.text.trim()) return [];

  const items: ExtractedEvidenceInput[] = [];
  const seen = new Set<string>();

  for (const match of input.text.matchAll(COMMIT_CONTEXT_RE)) {
    const sha = match[1]?.toLowerCase();
    if (!sha) continue;
    pushUnique(
      items,
      baseEvidence(input, "commit", `Candidate commit ${sha.slice(0, 12)}`, { commitSha: sha, matchedText: normalizeWhitespace(match[0] ?? sha) }, { uri: `commit:${sha}` }),
      seen,
    );
  }
  for (const match of input.text.matchAll(FULL_COMMIT_RE)) {
    const sha = match[1]?.toLowerCase();
    if (!sha) continue;
    pushUnique(
      items,
      baseEvidence(input, "commit", `Candidate commit ${sha.slice(0, 12)}`, { commitSha: sha, matchedText: sha }, { uri: `commit:${sha}` }),
      seen,
    );
  }

  extractCommandEvidence(input, seen, items);

  for (const match of input.text.matchAll(URL_RE)) {
    const uri = stripWrapping(match[0] ?? "");
    if (!uri) continue;
    const type: AutonomyEvidenceType = IMAGE_EXT_RE.test(uri) ? "screenshot" : "external_api_check";
    pushUnique(
      items,
      baseEvidence(input, type, type === "screenshot" ? `Candidate screenshot ${uri}` : `Candidate URL ${uri}`, { url: uri }, { uri }),
      seen,
    );
  }

  for (const match of input.text.matchAll(IMAGE_PATH_RE)) {
    const path = stripWrapping(match[1] ?? "");
    if (!path || /^https?:\/\//i.test(path)) continue;
    pushUnique(
      items,
      baseEvidence(input, "screenshot", `Candidate screenshot ${path}`, { path }, { uri: path }),
      seen,
    );
  }

  for (const match of input.text.matchAll(MARKDOWN_DOC_LINK_RE)) {
    const label = normalizeWhitespace(match[1] ?? "document");
    const uri = stripWrapping(match[2] ?? "");
    if (!uri) continue;
    pushUnique(items, baseEvidence(input, "document", `Candidate document ${label}`, { label, path: uri }, { uri }), seen);
  }
  for (const match of input.text.matchAll(DOC_PATH_RE)) {
    const path = stripWrapping(match[1] ?? "");
    if (!path || /^https?:\/\//i.test(path)) continue;
    pushUnique(items, baseEvidence(input, "document", `Candidate document ${path}`, { path }, { uri: path }), seen);
  }

  for (const match of input.text.matchAll(WORK_PRODUCT_RE)) {
    const ref = stripWrapping(match[1] ?? "");
    if (!ref) continue;
    pushUnique(items, baseEvidence(input, "work_product", `Candidate work product ${ref}`, { reference: ref }, { uri: ref }), seen);
  }

  for (const match of input.text.matchAll(APPROVAL_DECISION_RE)) {
    const text = normalizeWhitespace(match[0] ?? "");
    const decisionToken = (match[1] ?? text.match(/\bapproved\b/i)?.[0] ?? text.match(/\b(?:rejected|denied)\b/i)?.[0] ?? "").toLowerCase();
    const decision = decisionToken === "denied" ? "rejected" : decisionToken;
    if (decision !== "approved" && decision !== "rejected") continue;
    pushUnique(
      items,
      baseEvidence(input, "approval_decision", `Candidate approval decision: ${decision}`, {
        decision,
        approver: match[2] ? stripWrapping(normalizeWhitespace(match[2])) : null,
        matchedText: text,
      }),
      seen,
    );
  }

  for (const pattern of [BLOCKER_RE, OWNER_ACTION_RE]) {
    for (const match of input.text.matchAll(pattern)) {
      const owner = normalizeWhitespace(match[1] ?? "");
      const action = normalizeWhitespace(match[2] ?? "");
      if (!owner || !action) continue;
      pushUnique(
        items,
        baseEvidence(input, "blocked_dependency", `Candidate blocker owned by ${owner}`, {
          owner,
          unblockAction: action,
          matchedText: normalizeWhitespace(match[0] ?? ""),
        }),
        seen,
      );
    }
  }

  return items;
}

export function createEvidenceExtractorService() {
  return { extractEvidenceCandidates };
}
