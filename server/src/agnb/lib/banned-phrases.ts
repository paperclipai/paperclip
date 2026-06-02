/**
 * Detect AI-tell phrases + clichés in blog drafts — ported from
 * agnb lib/agnb/banned-phrases.ts. Pure regex compute, no Gemini.
 */

export interface PhraseFlag {
  pattern: string;
  match: string;
  position: number;
  category: "cliche" | "ai_tell" | "weak_transition" | "weasel" | "fluff";
  severity: "warn" | "info";
  suggestion?: string;
}

const RULES: Array<{ regex: RegExp; category: PhraseFlag["category"]; severity: PhraseFlag["severity"]; suggestion?: string }> = [
  // AI tells
  { regex: /\bin today'?s fast-paced\b/gi, category: "cliche", severity: "warn", suggestion: "drop opener, start with claim" },
  { regex: /\b(are|is) you tired of\b/gi, category: "cliche", severity: "warn", suggestion: "lead with insight, not pain rhetorical" },
  { regex: /\blet'?s dive (?:in|into)\b/gi, category: "cliche", severity: "warn", suggestion: "remove — just start" },
  { regex: /\bin this (?:article|blog post)\b/gi, category: "ai_tell", severity: "warn", suggestion: "remove meta-narration" },
  { regex: /\bwe will explore\b/gi, category: "ai_tell", severity: "warn", suggestion: "just say what you'll say" },
  { regex: /\bleading provider of\b/gi, category: "cliche", severity: "warn", suggestion: "be specific about what you do" },
  { regex: /\bin conclusion\b/gi, category: "cliche", severity: "warn", suggestion: "kill phrase, end with substance" },
  { regex: /\bto wrap (?:it|things|this) up\b/gi, category: "cliche", severity: "warn" },
  { regex: /\bsynergy|synergies?\b/gi, category: "cliche", severity: "warn", suggestion: "specific verb instead" },
  { regex: /\bcutting-edge\b/gi, category: "cliche", severity: "warn", suggestion: "name the technique" },
  { regex: /\brevolutionize|revolutionary\b/gi, category: "cliche", severity: "warn" },
  { regex: /\bgame-changing|game changer\b/gi, category: "cliche", severity: "warn" },
  { regex: /\bleverage\b/gi, category: "cliche", severity: "info", suggestion: "say 'use'" },
  { regex: /\butilize\b/gi, category: "cliche", severity: "info", suggestion: "say 'use'" },
  // Weak transitions / fluff
  { regex: /\bfurthermore\b/gi, category: "weak_transition", severity: "info", suggestion: "drop or restructure" },
  { regex: /\bmoreover\b/gi, category: "weak_transition", severity: "info" },
  { regex: /\bit'?s (?:important|worth) (?:to note|noting|mentioning) that\b/gi, category: "fluff", severity: "warn", suggestion: "just say the note" },
  { regex: /\bnotably\b/gi, category: "weak_transition", severity: "info" },
  { regex: /\bindeed\b/gi, category: "weak_transition", severity: "info" },
  // Weasel
  { regex: /\bmany experts (?:say|agree|believe)\b/gi, category: "weasel", severity: "warn", suggestion: "cite a specific source" },
  { regex: /\bstudies (?:show|have shown)\b/gi, category: "weasel", severity: "warn", suggestion: "cite the actual study" },
  // AI tells (paragraph patterns)
  { regex: /^—.*?—/gm, category: "ai_tell", severity: "info", suggestion: "frequent em-dashes are AI tell" },
];

export function findBannedPhrases(text: string): PhraseFlag[] {
  const flags: PhraseFlag[] = [];
  for (const rule of RULES) {
    const matches = text.matchAll(rule.regex);
    for (const m of matches) {
      flags.push({
        pattern: rule.regex.source,
        match: m[0],
        position: m.index ?? 0,
        category: rule.category,
        severity: rule.severity,
        suggestion: rule.suggestion,
      });
    }
  }
  return flags;
}

export function summarizeFlags(flags: PhraseFlag[]): { warn: number; info: number; by_category: Record<string, number> } {
  const by_category: Record<string, number> = {};
  let warn = 0, info = 0;
  for (const f of flags) {
    by_category[f.category] = (by_category[f.category] ?? 0) + 1;
    if (f.severity === "warn") warn++; else info++;
  }
  return { warn, info, by_category };
}
