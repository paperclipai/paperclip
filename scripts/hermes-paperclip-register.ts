import { existsSync } from "node:fs";
import { and, eq } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  companies,
  createDb,
  issues,
  projects,
} from "../packages/db/src/index.js";
import { resolveMigrationConnection } from "../packages/db/src/migration-runtime.js";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_WORK_MODES,
  createIssueSchema,
  createProjectSchema,
} from "../packages/shared/src/index.js";
import { issueService } from "../server/src/services/issues.js";
import { projectService } from "../server/src/services/projects.js";
import { buildExistingIssueUpdatePatch, buildListSummary } from "../cli/src/hermes-paperclip-register-utils.js";

type Args = {
  command: "list" | "ensure-test" | "create";
  companyId?: string;
  projectName: string;
  projectDescription?: string;
  issueTitle?: string;
  issueDescription?: string;
  status: (typeof ISSUE_STATUSES)[number];
  priority: (typeof ISSUE_PRIORITIES)[number];
  workMode: (typeof ISSUE_WORK_MODES)[number];
  originKind: string;
  originId: string;
  originFingerprint?: string;
  dryRun: boolean;
  json: boolean;
};

const DEFAULT_PROJECT_NAME = "AI Agents Visual Cockpit";
const DEFAULT_PROJECT_DESCRIPTION =
  "Local Hermes/Paperclip cockpit for coordinating Alfred, Dédalo and personal AI-agent work.";
const DEFAULT_ISSUE_TITLE = "Wire Dédalo task creation into Paperclip";
const DEFAULT_ISSUE_DESCRIPTION =
  "Validate a safe local path for Dédalo to register projects and tasks in Paperclip without exposing credentials.";

function usage(): never {
  console.error(`Usage:
  pnpm exec tsx scripts/hermes-paperclip-register.ts list [--json]
  pnpm exec tsx scripts/hermes-paperclip-register.ts ensure-test [--company <uuid>] [--dry-run] [--json]
  pnpm exec tsx scripts/hermes-paperclip-register.ts create --project <name> --issue <title> [--company <uuid>] [--project-description <text>] [--issue-description <text>] [--status <status>] [--priority <priority>] [--work-mode <mode>] [--origin-kind <kind>] [--origin-id <id>] [--origin-fingerprint <value>] [--dry-run] [--json]

Notes:
  - Resolves the local Paperclip DB via runtime config/env but never prints the connection string.
  - Refuses ambiguous company selection unless --company is provided.
  - Idempotent by project name and issue title within the selected project.`);
  process.exit(2);
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function readEnumFlag<T extends readonly string[]>(argv: string[], name: string, allowed: T, fallback: T[number]): T[number] {
  const value = readFlag(argv, name);
  if (!value) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${name}: ${value}. Expected one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function parseArgs(argv: string[]): Args {
  if (argv[0] === "--") argv = argv.slice(1);
  if (argv.includes("--help") || argv.includes("-h")) usage();
  const command = argv[0] as Args["command"] | undefined;
  if (!command || !["list", "ensure-test", "create"].includes(command)) usage();
  return {
    command,
    companyId: readFlag(argv, "--company"),
    projectName: readFlag(argv, "--project") ?? DEFAULT_PROJECT_NAME,
    projectDescription: readFlag(argv, "--project-description"),
    issueTitle: readFlag(argv, "--issue") ?? (command === "create" ? undefined : DEFAULT_ISSUE_TITLE),
    issueDescription: readFlag(argv, "--issue-description"),
    status: readEnumFlag(argv, "--status", ISSUE_STATUSES, "backlog"),
    priority: readEnumFlag(argv, "--priority", ISSUE_PRIORITIES, "medium"),
    workMode: readEnumFlag(argv, "--work-mode", ISSUE_WORK_MODES, "standard"),
    originKind: readFlag(argv, "--origin-kind") ?? "hermes_agent",
    originId: readFlag(argv, "--origin-id") ?? "alfred-paperclip-hook",
    originFingerprint: readFlag(argv, "--origin-fingerprint"),
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
  };
}

function printResult(json: boolean, result: unknown) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result);
}

async function main() {
  if (!process.env.PAPERCLIP_HOME && existsSync("/Users/imac/.paperclip")) {
    process.env.PAPERCLIP_HOME = "/Users/imac/.paperclip";
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "create" && !args.issueTitle) usage();

  const connection = await resolveMigrationConnection();
  const db = createDb(connection.connectionString);

  try {
    const companyRows = await db
      .select({ id: companies.id, name: companies.name, status: companies.status, issuePrefix: companies.issuePrefix })
      .from(companies);

    if (args.command === "list") {
      const projectRows = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name, status: projects.status })
        .from(projects);
      const issueRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues);

      printResult(args.json, buildListSummary({ databaseSource: connection.source, companies: companyRows, projects: projectRows, issues: issueRows }));
      return;
    }

    const selectedCompany = args.companyId
      ? companyRows.find((company) => company.id === args.companyId)
      : companyRows.length === 1
        ? companyRows[0]
        : null;

    if (!selectedCompany) {
      throw new Error(
        args.companyId
          ? `Company not found: ${args.companyId}`
          : `Ambiguous company selection: found ${companyRows.length} companies. Re-run with --company <uuid>.`,
      );
    }

    const projectPayload = createProjectSchema.parse({
      name: args.projectName,
      description: args.projectDescription ?? DEFAULT_PROJECT_DESCRIPTION,
      status: "in_progress",
      color: null,
    });
    const issuePayload = createIssueSchema.parse({
      projectId: undefined,
      title: args.issueTitle,
      description: args.issueDescription ?? DEFAULT_ISSUE_DESCRIPTION,
      status: args.status,
      priority: args.priority,
      workMode: args.workMode,
    });

    const existingProject = await db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, selectedCompany.id), eq(projects.name, projectPayload.name)))
      .then((rows) => rows[0] ?? null);

    if (args.dryRun) {
      printResult(args.json, {
        dryRun: true,
        company: { id: selectedCompany.id, name: selectedCompany.name },
        project: existingProject
          ? { action: "reuse", id: existingProject.id, name: existingProject.name }
          : { action: "create", name: projectPayload.name },
        issue: { action: "create-or-reuse", title: issuePayload.title, status: issuePayload.status, priority: issuePayload.priority },
      });
      return;
    }

    const projectsSvc = projectService(db);
    const issuesSvc = issueService(db);

    const project = existingProject
      ? existingProject
      : await projectsSvc.create(selectedCompany.id, {
          name: projectPayload.name,
          description: projectPayload.description ?? null,
          status: projectPayload.status,
          color: projectPayload.color ?? null,
        });

    const existingIssue = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        description: issues.description,
      })
      .from(issues)
      .where(and(eq(issues.companyId, selectedCompany.id), eq(issues.projectId, project.id), eq(issues.title, issuePayload.title)))
      .then((rows) => rows[0] ?? null);

    const existingIssuePatch = existingIssue
      ? buildExistingIssueUpdatePatch(existingIssue, {
          status: issuePayload.status,
          priority: issuePayload.priority,
          description: issuePayload.description ?? null,
        })
      : null;

    const issue = existingIssue
      ? existingIssuePatch
        ? await issuesSvc.update(existingIssue.id, existingIssuePatch)
        : existingIssue
      : await issuesSvc.create(selectedCompany.id, {
          ...issuePayload,
          projectId: project.id,
          originKind: args.originKind,
          originId: args.originId,
          originFingerprint: args.originFingerprint ?? `project:${project.id}:title:${issuePayload.title}`,
        });

    if (!issue) {
      throw new Error(`Issue update failed: ${existingIssue?.id ?? issuePayload.title}`);
    }

    printResult(args.json, {
      company: { id: selectedCompany.id, name: selectedCompany.name },
      project: {
        action: existingProject ? "reused" : "created",
        id: project.id,
        name: project.name,
        status: project.status,
      },
      issue: {
        action: existingIssue ? (existingIssuePatch ? "updated" : "reused") : "created",
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
      },
    });
  } finally {
    await connection.stop();
  }
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`hermes-paperclip-register failed: ${message}`);
    process.exit(1);
  });
