import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "credential-scanner-config.json");

interface PrefixRule {
  kind: "prefix";
  prefix: string;
  typeHint: string;
  /** Suffix pattern (regex string) to match after the prefix */
  suffixPattern: string;
}

interface RegexRule {
  kind: "regex";
  typeHint: string;
  /** Full regex pattern (no flags; always global) */
  pattern: string;
}

type CredentialRule = PrefixRule | RegexRule;

interface ScannerConfig {
  rules: CredentialRule[];
}

export interface ScanMatch {
  typeHint: string;
  characterOffset: number;
  inputLength: number;
}

export interface ScanResult {
  text: string;
  matches: ScanMatch[];
}

function loadConfig(): ScannerConfig {
  let config: ScannerConfig = { rules: [] };

  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ScannerConfig;
    } catch {
      // malformed config — fall through to empty rule set
    }
  }

  // Env-driven extra rules: SH12_EXTRA_RULES=JSON array of CredentialRule
  const envExtra = process.env["SH12_EXTRA_RULES"];
  if (envExtra) {
    try {
      const extra = JSON.parse(envExtra) as CredentialRule[];
      if (Array.isArray(extra)) {
        config = { rules: [...config.rules, ...extra] };
      }
    } catch {
      // ignore malformed env override
    }
  }

  return config;
}

interface CompiledRule {
  typeHint: string;
  regex: RegExp;
}

function compileRule(rule: CredentialRule): CompiledRule {
  if (rule.kind === "prefix") {
    const escapedPrefix = rule.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      typeHint: rule.typeHint,
      regex: new RegExp(`${escapedPrefix}${rule.suffixPattern}`, "g"),
    };
  }
  return {
    typeHint: rule.typeHint,
    regex: new RegExp(rule.pattern, "g"),
  };
}

let _compiledRules: CompiledRule[] | null = null;

function getCompiledRules(): CompiledRule[] {
  if (_compiledRules) return _compiledRules;
  const config = loadConfig();
  _compiledRules = config.rules.map(compileRule);
  return _compiledRules;
}

/** Reset compiled rule cache — used in tests to apply a fresh config */
export function resetScannerRuleCache(): void {
  _compiledRules = null;
}

/**
 * Scan `input` for credential-shaped tokens and redact each match.
 *
 * Stateless and side-effect-free. Never stores, logs, or forwards matched values.
 * Telemetry payloads contain only `{typeHint, characterOffset, inputLength}`.
 */
export function scanAndRedact(input: string): ScanResult {
  if (!input) return { text: input, matches: [] };

  const rules = getCompiledRules();
  const matches: ScanMatch[] = [];
  let text = input;

  for (const rule of rules) {
    const replacement = `[REDACTED:SH-12:${rule.typeHint}]`;
    const rawMatches: Array<{ index: number; matchLength: number }> = [];

    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(text)) !== null) {
      rawMatches.push({ index: m.index, matchLength: m[0].length });
      // Guard against zero-length match infinite loops
      if (m[0].length === 0) { rule.regex.lastIndex++; }
    }

    if (rawMatches.length === 0) continue;

    // Rebuild text with replacements and record offset metadata (NO values)
    let result = "";
    let cursor = 0;
    let offsetDelta = 0;

    for (const raw of rawMatches) {
      result += text.slice(cursor, raw.index);
      matches.push({
        typeHint: rule.typeHint,
        characterOffset: raw.index + offsetDelta,
        inputLength: raw.matchLength,
      });
      result += replacement;
      cursor = raw.index + raw.matchLength;
      offsetDelta += replacement.length - raw.matchLength;
    }
    result += text.slice(cursor);
    text = result;
  }

  return { text, matches };
}
