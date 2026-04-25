export type AuditViolation = {
  pattern: string;
  line: number;
  column: number;
  matched: string;
  category: "slop" | "secret" | "generic";
};

export type AuditResult = {
  passed: boolean;
  violations: AuditViolation[];
  scannedFiles: number;
  scannedBytes: number;
  durationMs: number;
};

const PROSE_BANNED_PATTERNS: { pattern: RegExp; phrase: string }[] = [
  { pattern: /\bfurthermore\b/gi, phrase: "furthermore" },
  { pattern: /\bmoreover\b/gi, phrase: "moreover" },
  { pattern: /\badditionally\b/gi, phrase: "additionally" },
  { pattern: /\bit is important to note\b/gi, phrase: "it is important to note" },
  { pattern: /\bit's important to note\b/gi, phrase: "it's important to note" },
  { pattern: /\bit is worth noting\b/gi, phrase: "it is worth noting" },
  { pattern: /\bit's worth noting\b/gi, phrase: "it's worth noting" },
  { pattern: /\bin today's fast-paced\b/gi, phrase: "in today's fast-paced" },
  { pattern: /\bin the ever-evolving\b/gi, phrase: "in the ever-evolving" },
  { pattern: /\bleverage\b/gi, phrase: "leverage" },
  { pattern: /\bsynergy\b/gi, phrase: "synergy" },
  { pattern: /\bseamless\b/gi, phrase: "seamless" },
  { pattern: /\brobust\b/gi, phrase: "robust" },
  { pattern: /\bcutting-edge\b/gi, phrase: "cutting-edge" },
  { pattern: /\bdelve into\b/gi, phrase: "delve into" },
  { pattern: /\bnavigate the complexities\b/gi, phrase: "navigate the complexities" },
  { pattern: /\bunleash\b/gi, phrase: "unleash" },
  { pattern: /\bunlock the power of\b/gi, phrase: "unlock the power of" },
  { pattern: /\brevolutionary\b/gi, phrase: "revolutionary" },
  { pattern: /\bgame-changer\b/gi, phrase: "game-changer" },
  { pattern: /\bgame changer\b/gi, phrase: "game changer" },
  { pattern: /\bparadigm shift\b/gi, phrase: "paradigm shift" },
  { pattern: /\bworld-class\b/gi, phrase: "world-class" },
  { pattern: /\bbest-in-class\b/gi, phrase: "best-in-class" },
  { pattern: /\bstate-of-the-art\b/gi, phrase: "state-of-the-art" },
  { pattern: /\bthought leader\b/gi, phrase: "thought leader" },
  { pattern: /\blow-hanging fruit\b/gi, phrase: "low-hanging fruit" },
  { pattern: /\bcircle back\b/gi, phrase: "circle back" },
  { pattern: /\bmoving forward\b/gi, phrase: "moving forward" },
  { pattern: /\bat the end of the day\b/gi, phrase: "at the end of the day" },
  { pattern: /\bneedless to say\b/gi, phrase: "needless to say" },
  { pattern: /\bin conclusion\b/gi, phrase: "in conclusion" },
];

const GENERIC_VARIABLE_PATTERNS: { pattern: RegExp; phrase: string }[] = [
  { pattern: /\bdata\b/gi, phrase: "generic variable 'data'" },
  { pattern: /\bresult\b/gi, phrase: "generic variable 'result'" },
  { pattern: /\btemp\b/gi, phrase: "generic variable 'temp'" },
  { pattern: /\bthing\b/gi, phrase: "generic variable 'thing'" },
  { pattern: /\bitem\b/gi, phrase: "generic variable 'item'" },
  { pattern: /\bvalue\b/gi, phrase: "generic variable 'value'" },
];

const SECRET_PATTERNS: { pattern: RegExp; phrase: string }[] = [
  { pattern: /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi, phrase: "hardcoded API key" },
  { pattern: /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"][a-zA-Z0-9_/-]{20,}['"]/gi, phrase: "hardcoded secret" },
  { pattern: /sk-[a-zA-Z0-9]{48}/g, phrase: "OpenAI API key pattern" },
  { pattern: /sk-ant-[a-zA-Z0-9]{48,}/g, phrase: "Anthropic API key pattern" },
];

const EM_DASH_PATTERN = /\u2014/g;

function auditContent(content: string, filePath: string): AuditViolation[] {
  const violations: AuditViolation[] = [];
  const lines = content.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    for (const { pattern, phrase } of PROSE_BANNED_PATTERNS) {
      const matches = line.matchAll(new RegExp(pattern.source, pattern.flags));
      for (const match of matches) {
        if (match.index !== undefined) {
          violations.push({
            pattern: phrase,
            line: lineNum,
            column: match.index + 1,
            matched: match[0] ?? "",
            category: "slop",
          });
        }
      }
    }

    for (const { pattern, phrase } of GENERIC_VARIABLE_PATTERNS) {
      const matches = line.matchAll(new RegExp(pattern.source, pattern.flags));
      for (const match of matches) {
        if (match.index !== undefined) {
          violations.push({
            pattern: phrase,
            line: lineNum,
            column: match.index + 1,
            matched: match[0] ?? "",
            category: "generic",
          });
        }
      }
    }

    for (const { pattern, phrase } of SECRET_PATTERNS) {
      const matches = line.matchAll(new RegExp(pattern.source, pattern.flags));
      for (const match of matches) {
        if (match.index !== undefined) {
          violations.push({
            pattern: phrase,
            line: lineNum,
            column: match.index + 1,
            matched: match[0] ?? "",
            category: "secret",
          });
        }
      }
    }

    const emDashMatches = line.matchAll(EM_DASH_PATTERN);
    for (const match of emDashMatches) {
      if (match.index !== undefined) {
        violations.push({
          pattern: "em-dash (—)",
          line: lineNum,
          column: match.index + 1,
          matched: "—",
          category: "slop",
        });
      }
    }
  }

  return violations;
}

export function auditPrompt(content: string): AuditResult {
  const start = Date.now();
  const violations = auditContent(content, "<prompt>");
  return {
    passed: violations.length === 0,
    violations,
    scannedFiles: 1,
    scannedBytes: content.length,
    durationMs: Date.now() - start,
  };
}

export function auditSummarize(result: AuditResult): string {
  if (result.passed) return `Audit passed (${result.scannedFiles} files, ${result.scannedBytes} bytes, ${result.durationMs}ms)`;
  const byCategory = result.violations.reduce((acc, v) => {
    acc[v.category] = (acc[v.category] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return `Audit FAILED: ${result.violations.length} violations (${Object.entries(byCategory).map(([k, v]) => `${v} ${k}`).join(", ")})`;
}
