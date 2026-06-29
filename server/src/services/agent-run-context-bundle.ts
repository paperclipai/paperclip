import fs from "node:fs/promises";
import path from "node:path";

export const AGENT_RUN_CONTEXT_BUNDLE_SCHEMA_VERSION = 1;

const SENSITIVE_KEY_RE = /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

export interface AgentRunContextIssueSummary {
  id: string | null;
  identifier: string | null;
  title: string | null;
  description?: string | null;
  status: string | null;
  priority: string | null;
}

export interface AgentRunContextBundle {
  schemaVersion: typeof AGENT_RUN_CONTEXT_BUNDLE_SCHEMA_VERSION;
  source: "paperclip.agent_run_context_bundle";
  sourceServices: {
    builder: string;
    adapterInjection: string;
    fileTransport: string;
  };
  company: {
    id: string | null;
    name: string | null;
    description: string | null;
    operatingPolicySummary: string;
  };
  agent: {
    id: string | null;
    name: string | null;
    role: string | null;
    title: string | null;
    permissions: Record<string, unknown>;
    reportsTo: string | null;
  };
  issue: AgentRunContextIssueSummary & {
    workMode: string | null;
  };
  graph: {
    parent: AgentRunContextIssueSummary | null;
    linked: AgentRunContextIssueSummary[];
    blocking: AgentRunContextIssueSummary[];
    dependent: AgentRunContextIssueSummary[];
  };
  workspace: {
    path: string | null;
    repo: string | null;
    branch: string | null;
    dirtyStatus: string | null;
    openPrs: Array<Record<string, unknown>>;
    availability: {
      dirtyStatus: string;
      openPrs: string;
    };
  };
  run: {
    id: string | null;
    wakeReason: string | null;
    attributionPolicy: string;
  };
  policies: {
    routineTools: string[];
    completionPolicy: string;
    mcpRole: string;
    attributionBoundary: string;
  };
}

interface BuildAgentRunContextBundleInput {
  company: {
    id?: string | null;
    name?: string | null;
    description?: string | null;
  } | null;
  agent: {
    id?: string | null;
    name?: string | null;
    role?: string | null;
    title?: string | null;
    permissions?: Record<string, unknown> | null;
    reportsTo?: string | null;
  } | null;
  issue: (AgentRunContextIssueSummary & {
    workMode?: string | null;
  }) | null;
  graph?: {
    parent?: AgentRunContextIssueSummary | null;
    linked?: AgentRunContextIssueSummary[] | null;
    blocking?: AgentRunContextIssueSummary[] | null;
    dependent?: AgentRunContextIssueSummary[] | null;
  } | null;
  workspace?: {
    path?: string | null;
    repo?: string | null;
    branch?: string | null;
    dirtyStatus?: string | null;
    openPrs?: Array<Record<string, unknown>> | null;
  } | null;
  run: {
    id?: string | null;
    wakeReason?: string | null;
  } | null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summarizeIssue(value: Partial<AgentRunContextIssueSummary> | null | undefined): AgentRunContextIssueSummary | null {
  if (!value) return null;
  const summary: AgentRunContextIssueSummary = {
    id: nullableString(value.id),
    identifier: nullableString(value.identifier),
    title: nullableString(value.title),
    ...(Object.prototype.hasOwnProperty.call(value, "description")
      ? { description: nullableString(value.description) }
      : {}),
    status: nullableString(value.status),
    priority: nullableString(value.priority),
  };
  if (!summary.id && !summary.identifier && !summary.title) return null;
  return summary;
}

function summarizeIssueList(values: AgentRunContextIssueSummary[] | null | undefined): AgentRunContextIssueSummary[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((entry) => summarizeIssue(entry))
    .filter((entry): entry is AgentRunContextIssueSummary => Boolean(entry));
}

function sanitizeForContextFile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeForContextFile(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY_RE.test(key))
      .map(([key, entry]) => [key, sanitizeForContextFile(entry)]),
  );
}

export function buildAgentRunContextBundle(input: BuildAgentRunContextBundleInput): AgentRunContextBundle {
  const company = input.company ?? null;
  const agent = input.agent ?? null;
  const issue = input.issue ?? null;
  const graph = input.graph ?? null;
  const workspace = input.workspace ?? null;
  const run = input.run ?? null;

  const issueSummary = summarizeIssue(issue) ?? {
    id: null,
    identifier: null,
    title: null,
    description: null,
    status: null,
    priority: null,
  };

  return {
    schemaVersion: AGENT_RUN_CONTEXT_BUNDLE_SCHEMA_VERSION,
    source: "paperclip.agent_run_context_bundle",
    sourceServices: {
      builder: "server/src/services/heartbeat.ts: executeRun() builds context.paperclipRunContext before adapter.execute",
      adapterInjection: "server/src/adapters/registry.ts + server/src/adapters/hermes-paperclip-prompt.ts inject prompt context for hermes_local",
      fileTransport: "server/src/services/agent-run-context-bundle.ts writes non-secret .paperclip/context files in the run workspace",
    },
    company: {
      id: nullableString(company?.id),
      name: nullableString(company?.name),
      description: nullableString(company?.description),
      operatingPolicySummary:
        "Paperclip is a supervised control plane. Agents work scoped assigned issues, preserve attribution boundaries, and use MCP/API for live refresh and mutations rather than basic startup rediscovery.",
    },
    agent: {
      id: nullableString(agent?.id),
      name: nullableString(agent?.name),
      role: nullableString(agent?.role),
      title: nullableString(agent?.title),
      permissions: asRecord(agent?.permissions),
      reportsTo: nullableString(agent?.reportsTo),
    },
    issue: {
      ...issueSummary,
      description: nullableString(issue?.description),
      workMode: nullableString(issue?.workMode),
    },
    graph: {
      parent: summarizeIssue(graph?.parent),
      linked: summarizeIssueList(graph?.linked),
      blocking: summarizeIssueList(graph?.blocking),
      dependent: summarizeIssueList(graph?.dependent),
    },
    workspace: {
      path: nullableString(workspace?.path),
      repo: nullableString(workspace?.repo),
      branch: nullableString(workspace?.branch),
      dirtyStatus: nullableString(workspace?.dirtyStatus),
      openPrs: Array.isArray(workspace?.openPrs) ? workspace.openPrs : [],
      availability: {
        dirtyStatus: workspace?.dirtyStatus ? "provided_by_workspace_context" : "not_collected_in_this_slice",
        openPrs: workspace?.openPrs?.length ? "provided_by_workspace_context" : "not_collected_in_this_slice",
      },
    },
    run: {
      id: nullableString(run?.id),
      wakeReason: nullableString(run?.wakeReason),
      attributionPolicy:
        "Agent-authored comments and updates must use the Paperclip agent/run identity. Never attribute agent-authored content to Board, Owner, Abishek, or another human.",
    },
    policies: {
      routineTools: ["terminal", "Python", "repo search", "git status/diff", "focused local tests"],
      completionPolicy: "For product code: branch -> focused tests -> PR -> CI/review -> merge. Control-plane proposals may stop at a PR-ready slice plus focused verification.",
      mcpRole:
        "MCP/API remains for live refresh, comments, issue create/update, approvals, dashboard, and other control-plane operations; not for rediscovering basic run bootstrap context.",
      attributionBoundary:
        "SOURCE labels must identify real sources. Agent-authored Paperclip comments must be tied to the agent/run, never to a human owner unless the human authored the content.",
    },
  };
}

export function normalizeAgentRunContextBundle(value: unknown): AgentRunContextBundle | null {
  const record = asRecord(value);
  if (record.source !== "paperclip.agent_run_context_bundle") return null;
  const graph = asRecord(record.graph);
  return buildAgentRunContextBundle({
    company: asRecord(record.company),
    agent: asRecord(record.agent),
    issue: asRecord(record.issue) as unknown as AgentRunContextIssueSummary & { workMode?: string | null },
    graph: {
      parent: asRecord(graph.parent) as unknown as AgentRunContextIssueSummary,
      linked: Array.isArray(graph.linked) ? graph.linked as AgentRunContextIssueSummary[] : [],
      blocking: Array.isArray(graph.blocking) ? graph.blocking as AgentRunContextIssueSummary[] : [],
      dependent: Array.isArray(graph.dependent) ? graph.dependent as AgentRunContextIssueSummary[] : [],
    },
    workspace: asRecord(record.workspace) as BuildAgentRunContextBundleInput["workspace"],
    run: asRecord(record.run),
  });
}

function renderIssueLine(label: string, issue: AgentRunContextIssueSummary | null): string {
  if (!issue) return `- ${label}: none`;
  const issueLabel = issue.identifier ?? issue.id ?? "unknown";
  const status = issue.status ? ` (${issue.status})` : "";
  return `- ${label}: ${issueLabel}${issue.title ? ` ${issue.title}` : ""}${status}`;
}

function renderIssueList(label: string, issues: AgentRunContextIssueSummary[]): string {
  if (issues.length === 0) return `- ${label}: none`;
  return [`- ${label}:`, ...issues.map((issue) => {
    const issueLabel = issue.identifier ?? issue.id ?? "unknown";
    const status = issue.status ? ` (${issue.status})` : "";
    return `  - ${issueLabel}${issue.title ? ` ${issue.title}` : ""}${status}`;
  })].join("\n");
}

export function renderAgentRunContextBundlePrompt(bundle: AgentRunContextBundle): string {
  const issueLabel = bundle.issue.identifier ?? bundle.issue.id ?? "unknown";
  const lines = [
    "## Paperclip Agent Run Context Bundle",
    "",
    "Native bootstrap context is already available. Use MCP/API for live refresh and mutations, not to rediscover basics.",
    `- schema: v${bundle.schemaVersion}`,
    `- company: ${bundle.company.name ?? bundle.company.id ?? "unknown"}`,
    `- agent: ${bundle.agent.name ?? bundle.agent.id ?? "unknown"}${bundle.agent.role ? ` (${bundle.agent.role})` : ""}`,
    `- issue: ${issueLabel}${bundle.issue.title ? ` ${bundle.issue.title}` : ""}${bundle.issue.status ? ` (${bundle.issue.status})` : ""}`,
    `- run: ${bundle.run.id ?? "unknown"}; wakeReason=${bundle.run.wakeReason ?? "unknown"}`,
    renderIssueLine("parent", bundle.graph.parent),
    renderIssueList("linked issues", bundle.graph.linked),
    renderIssueList("blocking issues", bundle.graph.blocking),
    renderIssueList("dependent issues", bundle.graph.dependent),
    `- workspace: ${bundle.workspace.path ?? "unknown"}${bundle.workspace.branch ? ` branch=${bundle.workspace.branch}` : ""}${bundle.workspace.repo ? ` repo=${bundle.workspace.repo}` : ""}`,
    `- routine tools: ${bundle.policies.routineTools.join(", ")}`,
    `- completion policy: ${bundle.policies.completionPolicy}`,
    `- MCP/API role: ${bundle.policies.mcpRole}`,
    `- attribution: ${bundle.run.attributionPolicy}`,
    "",
    "Source services:",
    `- builder: ${bundle.sourceServices.builder}`,
    `- adapter injection: ${bundle.sourceServices.adapterInjection}`,
    `- file transport: ${bundle.sourceServices.fileTransport}`,
  ];
  return lines.join("\n");
}

export function renderAgentRunContextPoliciesMarkdown(bundle: AgentRunContextBundle): string {
  return [
    "# Paperclip Agent Run Context Policies",
    "",
    `Run: ${bundle.run.id ?? "unknown"}`,
    `Wake reason: ${bundle.run.wakeReason ?? "unknown"}`,
    "",
    "## Routine tools",
    ...bundle.policies.routineTools.map((tool) => `- ${tool}`),
    "",
    "## Completion policy",
    bundle.policies.completionPolicy,
    "",
    "## MCP/API role",
    bundle.policies.mcpRole,
    "",
    "## Attribution boundary",
    bundle.policies.attributionBoundary,
  ].join("\n");
}

export async function writeAgentRunContextBundleFiles(bundle: AgentRunContextBundle): Promise<string | null> {
  if (!bundle.workspace.path || !path.isAbsolute(bundle.workspace.path)) return null;
  const contextRoot = path.join(bundle.workspace.path, ".paperclip", "context");
  await fs.mkdir(contextRoot, { recursive: true });

  const writeJson = async (fileName: string, value: unknown) => {
    await fs.writeFile(
      path.join(contextRoot, fileName),
      `${JSON.stringify(sanitizeForContextFile(value), null, 2)}\n`,
      "utf8",
    );
  };

  await Promise.all([
    writeJson("company.json", bundle.company),
    writeJson("agent.json", bundle.agent),
    writeJson("issue.json", { issue: bundle.issue, graph: bundle.graph }),
    writeJson("workspace.json", bundle.workspace),
    writeJson("run.json", bundle.run),
    fs.writeFile(path.join(contextRoot, "policies.md"), `${renderAgentRunContextPoliciesMarkdown(bundle)}\n`, "utf8"),
  ]);

  return contextRoot;
}
