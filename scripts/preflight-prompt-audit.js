#!/usr/bin/env node
/**
 * Pre-flight prompt audit script
 * Blocks agent activation if forbidden patterns are present in the agent's prompt/instructions
 *
 * Usage: node scripts/preflight-prompt-audit.js <prompt_text> [--strict]
 *
 * Exits 0 if clean, exits 1 if forbidden patterns found (with details printed to stderr)
 */

const FORBIDDEN_PATTERNS = [
  {
    pattern: /furthermore|moreover|additionally|leverage|synergy|seamless|robust|cutting-edge/i,
    phrase: "AI slop phrases (furthermore, moreover, additionally, leverage, synergy, seamless, robust, cutting-edge)",
    severity: "major",
  },
  {
    pattern: /it's important to note|in today's fast-paced|delve into|unleash|unlock the power of/i,
    phrase: "AI slop phrases (it's important to note, in today's fast-paced, delve into, unleash, unlock the power of)",
    severity: "major",
  },
  {
    pattern: /world-class|best-in-class|revolutionary|game-changer|paradigm shift/i,
    phrase: "AI slop phrases (world-class, best-in-class, revolutionary, game-changer, paradigm shift)",
    severity: "major",
  },
  {
    pattern: /console\.(log|debug|info|warn|error)\s*\(/g,
    phrase: "console.log/debug/info/warn/error in committed code",
    severity: "minor",
  },
  {
    pattern: /process\.exit\s*\(\s*0\s*\)/g,
    phrase: "process.exit(0) in tests",
    severity: "minor",
  },
  {
    pattern: /: any\s*[,;)]/g,
    phrase: "': any' type without justification",
    severity: "minor",
  },
  {
    pattern: /em-dash|emdash|—/g,
    phrase: "em-dash (—) in prose",
    severity: "major",
  },
];

const FORBIDDEN_VARIABLE_NAMES = [
  { name: /\bdata\b/g, justification: "generic variable name 'data'" },
  { name: /\bresult\b/g, justification: "generic variable name 'result'" },
  { name: /\btemp\b/g, justification: "generic variable name 'temp'" },
  { name: /\bthing\b/g, justification: "generic variable name 'thing'" },
];

function auditPrompt(promptText, strict = false) {
  const findings = [];
  const lines = promptText.split("\n");

  for (const { pattern, phrase, severity } of FORBIDDEN_PATTERNS) {
    const matches = promptText.match(pattern);
    if (matches) {
      findings.push({
        severity,
        phrase,
        count: Array.isArray(matches) ? matches.length : 1,
        sample: Array.isArray(matches) ? matches[0] : matches,
      });
    }
  }

  for (const { name, justification } of FORBIDDEN_VARIABLE_NAMES) {
    const matches = promptText.match(name);
    if (matches) {
      findings.push({
        severity: "minor",
        phrase: justification,
        count: matches.length,
        sample: matches[0],
      });
    }
  }

  const majorFindings = findings.filter((f) => f.severity === "major");
  const minorFindings = findings.filter((f) => f.severity === "minor");

  if (majorFindings.length > 0 || (strict && minorFindings.length > 0)) {
    console.error("PRE-FLIGHT AUDIT FAILED");
    console.error("=".repeat(50));
    if (majorFindings.length > 0) {
      console.error("\nMAJOR findings (must fix):");
      for (const f of majorFindings) {
        console.error(`  - ${f.phrase} (${f.count}x): ${f.sample}`);
      }
    }
    if (strict && minorFindings.length > 0) {
      console.error("\nMinor findings (strict mode):");
      for (const f of minorFindings) {
        console.error(`  - ${f.phrase} (${f.count}x): ${f.sample}`);
      }
    }
    return { pass: false, findings };
  }

  return { pass: true, findings };
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const promptArg = args.filter((a) => !a.startsWith("--"));

if (promptArg.length === 0) {
  console.error("Usage: node scripts/preflight-prompt-audit.js <prompt_text> [--strict]");
  process.exit(1);
}

const promptText = promptArg.join(" ");
const result = auditPrompt(promptText, strict);

if (!result.pass) {
  process.exit(1);
}

console.log("PRE-FLIGHT AUDIT PASSED");
process.exit(0);
