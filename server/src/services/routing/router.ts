export interface RoutingInput {
  estCtx: number;
  estDiff: number;
  priority: string;
  description: string;
  hasOpusLabel?: boolean;
}

export interface RoutingDecision {
  chosenModel: string;
  reasoningEffort: "high" | "medium" | "low";
  ruleId: string;
}

export function routeIssue(input: RoutingInput): RoutingDecision {
  const description = input.description || "";
  const priority = input.priority || "medium";
  const estCtx = input.estCtx;
  const estDiff = input.estDiff;
  const hasOpusLabel = input.hasOpusLabel || false;

  // Manual Opus label override (Open Question 2)
  if (hasOpusLabel || /routing:opus/i.test(description)) {
    return {
      chosenModel: "opus-4.7",
      reasoningEffort: "high",
      ruleId: "manual_label_opus"
    };
  }

  // Helper to count referenced files (e.g. any file path with an extension or specific paths)
  const fileRegex = /[\w./-]+\.(ts|js|py|go|json|java|cpp|cs|sh|yml|yaml|html|css)/gi;
  const matches = description.match(fileRegex) || [];
  const uniqueFiles: string[] = [];
  for (const m of matches) {
    const val = m.toLowerCase();
    if (uniqueFiles.indexOf(val) === -1) {
      uniqueFiles.push(val);
    }
  }
  const referencedFilesCount = uniqueFiles.length;

  // Helper to check for multi-step tasks (e.g., numbered lists, markdown checklists, or explicit step keywords)
  const hasMultiStep = 
    /(?:step\s*\d+|\d+\.\s+\w+|\-\s+\[\s*\]|firstly|secondly|finally)/i.test(description) ||
    (description.match(/^\s*[-*+]\s+/gm) || []).length >= 3;

  // Rule 1: Large context / repo-wide sweep
  // est-ctx > 200k OR description matches 'whole-repo|long-doc|full sweep|cross-cutting refactor'
  if (estCtx > 200000 || /whole-repo|long-doc|full sweep|cross-cutting refactor/i.test(description)) {
    return {
      chosenModel: "opus-4.7",
      reasoningEffort: "high",
      ruleId: "rule1_large_context"
    };
  }

  // Rule 2: Complex/ambiguous (priority ∈ {critical,high} + ≥3 referenced files + multi-step)
  if ((priority === "critical" || priority === "high") && referencedFilesCount >= 3 && hasMultiStep) {
    return {
      chosenModel: "opus-4.7",
      reasoningEffort: "high",
      ruleId: "rule2_complex"
    };
  }

  // Rule 3: Routine draft (est-ctx ≤ 5k + drafting/comment-only)
  // drafting/comment-only: matches keyword hints like draft, comment, review, discussion, feedback
  const isDrafting = /draft|comment|review|discussion|feedback/i.test(description);
  if (estCtx <= 5000 && isDrafting) {
    return {
      chosenModel: "sonnet-4.6",
      reasoningEffort: "medium",
      ruleId: "rule3_routine_draft"
    };
  }

  // Rule 4: Trivial classify/summarize (est-ctx ≤ 1k + triage/label/tag task)
  const isTriage = /triage|label|tag|classify|summarize|category|categorize/i.test(description);
  if (estCtx <= 1000 && isTriage) {
    return {
      chosenModel: "haiku-4.5",
      reasoningEffort: "low",
      ruleId: "rule4_trivial"
    };
  }

  // Rule 5: Code patch/PR (touches code + est-diff ≤ 32k)
  const isCodeRelated = 
    /(\.ts|\.js|\.py|\.go|\.json|\.java|\.cpp|\.cs|\.sh|\.yml|\.yaml|code|patch|PR|refactor|compile|build|test|drizzle|schema|api)/i.test(description) ||
    description.indexOf("```") !== -1;
  if (isCodeRelated && estDiff <= 32000) {
    return {
      chosenModel: "gpt-5.5-codex",
      reasoningEffort: "medium",
      ruleId: "rule5_code_patch"
    };
  }

  // Fallback default: if it touches code but estDiff > 32k -> Opus reviews
  if (isCodeRelated) {
    return {
      chosenModel: "opus-4.7",
      reasoningEffort: "high",
      ruleId: "default_code_large_diff"
    };
  }

  // Default fallback for general issues: Sonnet 4.6
  return {
    chosenModel: "sonnet-4.6",
    reasoningEffort: "medium",
    ruleId: "default_fallback"
  };
}
