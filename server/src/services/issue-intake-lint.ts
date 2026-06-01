import type { IssueIntakeLintRule } from "@paperclipai/shared";

export function lintIssueIntake(
  rules: IssueIntakeLintRule[],
  input: { title: string; description?: string | null },
): { firedRules: IssueIntakeLintRule[] } {
  const haystack = `${input.title} ${input.description ?? ""}`;
  const firedRules: IssueIntakeLintRule[] = [];

  for (const rule of rules) {
    const testPattern = (p: string) => {
      try {
        return new RegExp(p).test(haystack);
      } catch {
        return false;
      }
    };
    const anyPatternMatches = rule.patterns.some(testPattern);
    if (!anyPatternMatches) continue;

    const anyExcludeMatches = (rule.excludePatterns ?? []).some(testPattern);
    if (anyExcludeMatches) continue;

    firedRules.push(rule);
  }

  return { firedRules };
}
