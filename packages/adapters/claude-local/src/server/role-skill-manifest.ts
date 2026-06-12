// Maps Paperclip agent role keys to allowlists of skill key patterns.
//
// Pattern matching: a skill key is allowed if it equals the pattern,
// or starts with the pattern followed by "--", "-", or "/".
// This lets a single pattern like "paperclip" cover "paperclip",
// "paperclip-dev", "paperclip-create-agent", etc., and "pdf" cover
// "pdf--3924e73e8d" and any future versioned variant.
//
// Unmapped roles receive all skills (pass-through).

export type RoleKey = string;
export type SkillKeyPattern = string;

export const ROLE_SKILL_MANIFEST: Readonly<Record<RoleKey, readonly SkillKeyPattern[]>> = {
  cto: [
    "paperclip",
    "writing-plans",
    "executing-plans",
    "brainstorming",
    "dispatching-parallel-agents",
    "subagent-driven-development",
    "paperclip-create-agent",
    "paperclip-create-plugin",
    "paperclip-converting-plans-to-tasks",
    "diagnose",
    "diagnose-why-work-stopped",
    "schedule",
    "loop",
    "para-memory-files",
    "grill-with-docs",
    "systematic-debugging",
    "receiving-code-review",
    "requesting-code-review",
    "review",
    "security-review",
    "mcp-builder",
    "skill-creator",
    "init",
    "terminal-bench-loop",
    "using-git-worktrees",
    "git-guardrails-claude-code",
  ],

  doe: [
    "paperclip",
    "writing-plans",
    "executing-plans",
    "brainstorming",
    "dispatching-parallel-agents",
    "subagent-driven-development",
    "paperclip-create-agent",
    "paperclip-dev",
    "paperclip-converting-plans-to-tasks",
    "diagnose",
    "diagnose-why-work-stopped",
    "schedule",
    "loop",
    "para-memory-files",
    "grill-with-docs",
    "systematic-debugging",
    "receiving-code-review",
    "requesting-code-review",
    "review",
    "security-review",
    "git-guardrails-claude-code",
    "using-git-worktrees",
    "init",
    "terminal-bench-loop",
  ],

  coder: [
    "paperclip",
    "paperclip-dev",
    "paperclip-create-agent",
    "paperclip-create-plugin",
    "paperclip-converting-plans-to-tasks",
    "systematic-debugging",
    "diagnose",
    "diagnose-why-work-stopped",
    "test-driven-development",
    "tdd",
    "verification-before-completion",
    "using-superpowers",
    "writing-plans",
    "executing-plans",
    "finishing-a-development-branch",
    "requesting-code-review",
    "receiving-code-review",
    "review",
    "security-review",
    "using-git-worktrees",
    "git-guardrails-claude-code",
    "webapp-testing",
    "subagent-driven-development",
    "dispatching-parallel-agents",
    "claude-api",
    "mcp-builder",
    "skill-creator",
    "update-config",
    "keybindings-help",
    "simplify",
    "fewer-permission-prompts",
    "loop",
    "schedule",
    "init",
    "para-memory-files",
    "grill-with-docs",
    "doc-coauthoring",
    "brainstorming",
    "terminal-bench-loop",
  ],

  "qa-regression": [
    "paperclip",
    "systematic-debugging",
    "diagnose",
    "diagnose-why-work-stopped",
    "test-driven-development",
    "tdd",
    "verification-before-completion",
    "webapp-testing",
    "using-git-worktrees",
    "writing-plans",
    "loop",
    "schedule",
    "para-memory-files",
    "grill-with-docs",
    "requesting-code-review",
  ],

  "qa-unit": [
    "paperclip",
    "systematic-debugging",
    "diagnose",
    "diagnose-why-work-stopped",
    "test-driven-development",
    "tdd",
    "verification-before-completion",
    "webapp-testing",
    "using-git-worktrees",
    "writing-plans",
    "loop",
    "schedule",
    "para-memory-files",
    "grill-with-docs",
    "requesting-code-review",
  ],

  "qa-integration": [
    "paperclip",
    "systematic-debugging",
    "diagnose",
    "diagnose-why-work-stopped",
    "test-driven-development",
    "tdd",
    "verification-before-completion",
    "webapp-testing",
    "using-git-worktrees",
    "writing-plans",
    "loop",
    "schedule",
    "para-memory-files",
    "grill-with-docs",
    "requesting-code-review",
  ],

  qa: [
    "paperclip",
    "systematic-debugging",
    "diagnose",
    "diagnose-why-work-stopped",
    "test-driven-development",
    "tdd",
    "verification-before-completion",
    "webapp-testing",
    "using-git-worktrees",
    "writing-plans",
    "loop",
    "schedule",
    "para-memory-files",
    "grill-with-docs",
    "requesting-code-review",
  ],

  // Document-heavy roles: keep document processing tools
  ea: [
    "paperclip",
    "pdf",
    "pptx",
    "docx",
    "xlsx",
    "writing-plans",
    "executing-plans",
    "para-memory-files",
    "brainstorming",
    "loop",
    "schedule",
    "grill-with-docs",
    "doc-coauthoring",
  ],

  // CEO orchestrates everything — no manifest entry means pass-through.
  // Other directors that aren't enumerated above also get pass-through.
} as const;

/**
 * Returns the role key for an agent name, or null if the name doesn't map to
 * a known role. Role detection strips platform qualifiers such as "(Claude)"
 * or "(GCP)" before matching.
 */
export function mapAgentNameToRoleKey(agentName: string): RoleKey | null {
  const stripped = agentName
    .trim()
    .replace(/\s*\([^)]+\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (/\bceo\b/.test(stripped)) return "ceo";
  if (/\bcto\b/.test(stripped)) return "cto";
  if (/\bcfo\b/.test(stripped)) return "cfo";
  if (/director\s+of\s+engineering\b/.test(stripped)) return "doe";
  if (/\bcoder\b/.test(stripped)) return "coder";
  if (/\bqa\b.*regress/.test(stripped)) return "qa-regression";
  if (/\bqa\b.*unit/.test(stripped)) return "qa-unit";
  if (/\bqa\b.*integr/.test(stripped)) return "qa-integration";
  if (/\bqa\b/.test(stripped)) return "qa";
  if (/pricing\s+director/.test(stripped)) return "pricing-director";
  if (/ssi\s+director/.test(stripped)) return "ssi-director";
  if (/marketing\s+director/.test(stripped)) return "marketing-director";
  if (/ops\s+director/.test(stripped)) return "ops-director";
  if (/bd\s+director/.test(stripped)) return "bd-director";
  if (/land\s+steward/.test(stripped)) return "land-steward";
  if (/executive\s+assistant/.test(stripped)) return "ea";
  return null;
}

/**
 * Returns true if the skill key matches the pattern, using prefix matching
 * with "--", "-", and "/" separators to cover versioned skill names.
 */
export function skillKeyMatchesPattern(skillKey: string, pattern: string): boolean {
  const k = skillKey.toLowerCase();
  const p = pattern.toLowerCase();
  return k === p || k.startsWith(p + "--") || k.startsWith(p + "-") || k.startsWith(p + "/");
}

/**
 * Filters the desiredSkillNames Set to only those allowed by the role manifest
 * for the given agent name. Roles not in the manifest pass through unchanged.
 * If onElided is provided it is called with the list of removed skill keys.
 */
export function applyRoleSkillFilter(
  desiredSkillNames: Set<string>,
  agentName: string,
  onElided?: (elided: readonly string[]) => void,
): Set<string> {
  const roleKey = mapAgentNameToRoleKey(agentName);
  if (roleKey === null) return desiredSkillNames;

  const allowedPatterns = ROLE_SKILL_MANIFEST[roleKey];
  if (!allowedPatterns) return desiredSkillNames;

  const result = new Set<string>();
  const elided: string[] = [];

  for (const skillKey of desiredSkillNames) {
    if (allowedPatterns.some((pattern) => skillKeyMatchesPattern(skillKey, pattern))) {
      result.add(skillKey);
    } else {
      elided.push(skillKey);
    }
  }

  if (onElided && elided.length > 0) {
    onElided(elided);
  }

  return result;
}
