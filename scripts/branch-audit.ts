import path from "node:path";
import {
  collectBranchAudit,
  deleteMergedLocalBranches,
  pruneGitWorktrees,
  type BranchAuditReport,
} from "../server/src/services/branch-audit.js";

type CliOptions = {
  repoRoot: string;
  baseRef: string;
  json: boolean;
  pruneWorktrees: boolean;
  deleteMerged: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repoRoot: process.cwd(),
    baseRef: "master",
    json: false,
    pruneWorktrees: false,
    deleteMerged: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--prune-worktrees") {
      options.pruneWorktrees = true;
      continue;
    }
    if (arg === "--delete-merged") {
      options.deleteMerged = true;
      continue;
    }
    if (arg === "--base") {
      options.baseRef = argv[index + 1] ?? options.baseRef;
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repoRoot = path.resolve(argv[index + 1] ?? options.repoRoot);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function pad(value: string, width: number) {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function printable(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function renderTextReport(report: BranchAuditReport) {
  const headers = ["Branch", "Merged", "Ahead", "Behind", "Worktree", "Upstream", "Last commit"];
  const rows = report.branches.map((branch) => [
    branch.name,
    branch.mergedIntoBase === null ? "?" : branch.mergedIntoBase ? "yes" : "no",
    printable(branch.aheadCount),
    printable(branch.behindCount),
    branch.worktreePath
      ? `${branch.worktreeState ?? "attached"}:${branch.worktreePath}`
      : "-",
    printable(branch.upstream),
    branch.lastSubject ? `${branch.lastCommit?.slice(0, 8) ?? "-"} ${branch.lastSubject}` : printable(branch.lastCommit),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );

  const lines = [
    `Repo: ${report.repoRoot}`,
    `Base: ${report.baseRef}`,
    `Generated: ${report.generatedAt.toISOString()}`,
    "",
    headers.map((header, index) => pad(header, widths[index]!)).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => row.map((cell, index) => pad(cell, widths[index]!)).join("  ")),
  ];

  return lines.join("\n");
}

function toSerializableReport(report: BranchAuditReport) {
  return {
    ...report,
    generatedAt: report.generatedAt.toISOString(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.pruneWorktrees) {
    await pruneGitWorktrees(options.repoRoot);
  }

  const deletionResult = options.deleteMerged
    ? await deleteMergedLocalBranches(options.repoRoot, {
        baseRef: options.baseRef,
        preserveAttachedWorktrees: true,
      })
    : null;
  const report = deletionResult?.report ?? await collectBranchAudit(options.repoRoot, { baseRef: options.baseRef });

  if (options.json) {
    console.log(JSON.stringify({
      report: toSerializableReport(report),
      deleted: deletionResult?.deleted ?? [],
      skipped: deletionResult?.skipped ?? [],
    }, null, 2));
    return;
  }

  console.log(renderTextReport(report));
  if (deletionResult) {
    console.log("");
    console.log(`Deleted merged branches: ${deletionResult.deleted.length > 0 ? deletionResult.deleted.join(", ") : "none"}`);
    if (deletionResult.skipped.length > 0) {
      console.log("Skipped:");
      for (const skipped of deletionResult.skipped) {
        console.log(`- ${skipped.branch}: ${skipped.reason}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
