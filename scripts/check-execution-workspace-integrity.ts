/**
 * Read-only audit: does every execution workspace still point at a directory
 * that can actually host its run?
 *
 * This is the check that was missing on 2026-09-19 (LUN-7697). Thirteen
 * execution workspaces carried the id of a `git_repo` project workspace and the
 * cwd of a sibling `non_git_path` workspace. Both values were individually
 * plausible, the folder existed, and every repository on the box passed
 * `git rev-parse` — so a repo-level sweep came back green while runs kept dying
 * before they started. The only control that catches it compares an execution
 * workspace's cwd against the project workspace its own row names.
 *
 * Usage:
 *   pnpm workspaces:check                # audit, human summary
 *   pnpm workspaces:check -- --json      # machine-readable
 *   pnpm workspaces:check -- --limit 20  # show more offenders per class
 *
 * Reads PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID. Writes
 * nothing, ever: it reports, a human decides.
 *
 * Deliberately NOT wired as a recurring Paperclip check. A tick that is almost
 * always a no-op costs a run every time it fires; this belongs in a hand, or in
 * a shell job that only speaks when it is red.
 *
 * Exit codes: 0 clean, 1 problems found, 2 could not run the audit.
 */
import {
  EXECUTION_WORKSPACE_FINDING_HEADLINES,
  auditExecutionWorkspaceRow,
  type ExecutionWorkspaceFinding,
  type ExecutionWorkspaceFindingKind,
  type ExecutionWorkspaceRef,
  type ProjectWorkspaceRef,
} from "../server/src/services/execution-workspace-integrity.js";

type ProjectWorkspace = ProjectWorkspaceRef & { projectId: string };

function readArg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function abort(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main() {
  const apiUrl = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env.PAPERCLIP_API_KEY ?? "";
  const companyId = process.env.PAPERCLIP_COMPANY_ID ?? "";
  if (!apiUrl || !apiKey || !companyId) {
    abort(
      "Set PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID before running this audit.",
    );
  }
  const base = apiUrl.endsWith("/api") ? apiUrl.slice(0, -4) : apiUrl;
  const asJson = process.argv.includes("--json");
  const limit = Number.parseInt(readArg("limit") ?? "5", 10) || 5;

  const get = async <T>(route: string): Promise<T> => {
    const response = await fetch(`${base}${route}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      abort(`GET ${route} returned ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  };

  const executionWorkspaces = await get<ExecutionWorkspaceRef[]>(
    `/api/companies/${companyId}/execution-workspaces`,
  );
  const projectIds = [
    ...new Set(
      executionWorkspaces
        .map((row) => row.projectId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const workspacesById = new Map<string, ProjectWorkspace>();
  const workspacesByProject = new Map<string, ProjectWorkspace[]>();
  for (const projectId of projectIds) {
    const rows = await get<ProjectWorkspace[]>(
      `/api/projects/${projectId}/workspaces`,
    );
    workspacesByProject.set(projectId, rows);
    for (const row of rows) workspacesById.set(row.id, row);
  }

  const findings: ExecutionWorkspaceFinding[] = [];
  // A project with no declared workspace at all runs in a Paperclip-managed
  // `_default` folder. Those are non-git by design; holding them to a git bar
  // would bury the real findings under thousands of false ones.
  let managedDefaultCount = 0;

  for (const row of executionWorkspaces) {
    const linkedWorkspace = row.projectWorkspaceId
      ? (workspacesById.get(row.projectWorkspaceId) ?? null)
      : null;
    const projectWorkspaces = row.projectId
      ? (workspacesByProject.get(row.projectId) ?? [])
      : [];
    if (!linkedWorkspace && projectWorkspaces.length === 0) {
      managedDefaultCount += 1;
      continue;
    }
    const finding = await auditExecutionWorkspaceRow({
      row,
      linkedWorkspace,
      projectWorkspaces,
    });
    if (finding) findings.push(finding);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          executionWorkspaces: executionWorkspaces.length,
          projects: projectIds.length,
          managedDefaultWorkspaces: managedDefaultCount,
          findings,
        },
        null,
        2,
      ),
    );
    process.exit(findings.length > 0 ? 1 : 0);
  }

  console.log(
    `Audited ${executionWorkspaces.length} execution workspaces across ${projectIds.length} projects.`,
  );
  console.log(
    `${managedDefaultCount} run in a Paperclip-managed default folder (no declared project workspace); not held to a git bar.`,
  );
  if (findings.length === 0) {
    console.log("No problems found.");
    process.exit(0);
  }
  const kinds = Object.keys(
    EXECUTION_WORKSPACE_FINDING_HEADLINES,
  ) as ExecutionWorkspaceFindingKind[];
  for (const kind of kinds) {
    const group = findings.filter((finding) => finding.kind === kind);
    if (group.length === 0) continue;
    console.log(
      `\n${group.length} x ${EXECUTION_WORKSPACE_FINDING_HEADLINES[kind]}`,
    );
    for (const finding of group.slice(0, limit)) {
      console.log(
        `  ${finding.executionWorkspaceId} issue=${finding.issueId ?? "-"} ${finding.cwd} ${finding.detail}`,
      );
    }
    if (group.length > limit) {
      console.log(`  ... and ${group.length - limit} more (--limit to widen)`);
    }
  }
  process.exit(1);
}

main().catch((error) => {
  abort(error instanceof Error ? error.message : String(error));
});
