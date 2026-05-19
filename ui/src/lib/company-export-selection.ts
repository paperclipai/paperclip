import type { CompanyPortabilityIssueManifestEntry } from "@paperclipai/shared";

function isTaskPath(filePath: string): boolean {
  return /(?:^|\/)tasks\//.test(filePath);
}

function buildRecurringTaskPrefixes(
  issues: Array<Pick<CompanyPortabilityIssueManifestEntry, "path" | "recurring">>,
): Set<string> {
  const prefixes = new Set<string>();

  for (const issue of issues) {
    if (!issue.recurring) continue;

    const filePath = issue.path.trim();
    if (!filePath) continue;

    prefixes.add(filePath);

    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash >= 0) {
      prefixes.add(`${filePath.slice(0, lastSlash + 1)}`);
    }
  }

  return prefixes;
}

function isRecurringTaskFile(filePath: string, recurringTaskPrefixes: Set<string>): boolean {
  for (const prefix of recurringTaskPrefixes) {
    if (filePath === prefix || filePath.startsWith(prefix)) return true;
  }
  return false;
}

export function buildInitialExportCheckedFiles(
  filePaths: string[],
  issues: Array<Pick<CompanyPortabilityIssueManifestEntry, "path" | "recurring">>,
  previousCheckedFiles: Set<string>,
): Set<string> {
  const next = new Set<string>();
  const recurringTaskPrefixes = buildRecurringTaskPrefixes(issues);

  for (const filePath of filePaths) {
    if (previousCheckedFiles.has(filePath)) {
      next.add(filePath);
      continue;
    }

    if (!isTaskPath(filePath) || isRecurringTaskFile(filePath, recurringTaskPrefixes)) {
      next.add(filePath);
    }
  }

  return next;
}
