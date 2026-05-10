import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Company = {
  id: string;
  name: string;
};

type Agent = {
  id: string;
  name: string;
  role: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
};

type Pipeline = {
  id: string;
  companyId: string;
  name: string;
  ownerAgentId?: string | null;
};

type PipelineNode = {
  id: string;
  nodeKey: string;
  kind: string;
  label: string;
};

type PipelineDetail = Pipeline & {
  nodes: PipelineNode[];
  edges: Array<{ sourceNodeId: string; targetNodeId: string; label?: string | null }>;
};

type PipelineSpec = {
  key: "econ" | "mat" | "for" | "website";
  code: "ECON" | "MAT" | "FOR" | "WEB";
  name: string;
  purpose: string;
  cadence: string;
  statePageKind?: "report" | "website";
  pipelineOwnerName?: string;
  nodes: Array<{
    key: string;
    kind: "input" | "transform" | "agent_task" | "approval" | "output" | "monitor" | "external";
    label: string;
    description: string;
    ownerName?: string;
  }>;
  edges: Array<[string, string, string?]>;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:3100/api";
const DEFAULT_COMPANY_NAME = "BCELab";
const DEFAULT_STATE_DIR = "knowledge/pipelines";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const PIPELINES: PipelineSpec[] = [
  {
    key: "econ",
    code: "ECON",
    name: "ECON Report Publishing",
    purpose: "Produce and publish recurring economic analysis reports for the Blockchain Economics Lab.",
    cadence: "Recurring report cycle",
    pipelineOwnerName: "CRO",
    nodes: [
      {
        key: "source_collection",
        kind: "input",
        label: "Slide PDF intake",
        description: "Detect new slide-form PDF files in Google Drive Slide/ECON, Slide/MAT, or Slide/FOR for this report type.",
        ownerName: "DataPlatformEngineer",
      },
      {
        key: "research_synthesis",
        kind: "agent_task",
        label: "Analysis source confirmation",
        description: "Confirm the matching markdown source exists in Google Drive analysis/ECON, analysis/MAT, or analysis/FOR before publication work continues.",
        ownerName: "CRO",
      },
      {
        key: "draft_report",
        kind: "agent_task",
        label: "Summary and marketing extraction",
        description: "Extract the publishable summary and marketing copy from the matching .md source. Do not translate the full report body.",
        ownerName: "CRO",
      },
      {
        key: "summary_marketing_localization",
        kind: "external",
        label: "7-language summary and marketing localization",
        description: "Translate or localize only the extracted summary, teaser, and marketing copy into 7 languages for website exposure.",
        ownerName: "FullStackEngineer",
      },
      {
        key: "editorial_review",
        kind: "approval",
        label: "Publication review",
        description: "Check slide PDF, markdown source alignment, extracted summary/marketing copy, localization quality, and release readiness.",
        ownerName: "COO",
      },
      {
        key: "website_publish",
        kind: "output",
        label: "Website publishing",
        description: "Publish the approved report to the BCELab website.",
        ownerName: "FullStackEngineer",
      },
      {
        key: "post_publish_monitoring",
        kind: "monitor",
        label: "Post-publish monitoring",
        description: "Monitor publication health, broken pages, formatting, and reader-facing issues.",
        ownerName: "COO",
      },
    ],
    edges: [
      ["source_collection", "research_synthesis"],
      ["research_synthesis", "draft_report"],
      ["draft_report", "summary_marketing_localization"],
      ["summary_marketing_localization", "editorial_review"],
      ["editorial_review", "website_publish"],
      ["website_publish", "post_publish_monitoring"],
    ],
  },
  {
    key: "mat",
    code: "MAT",
    name: "MAT Report Publishing",
    purpose: "Produce and publish recurring market and materials analysis reports for the Blockchain Economics Lab.",
    cadence: "Recurring report cycle",
    pipelineOwnerName: "CRO",
    nodes: [],
    edges: [],
  },
  {
    key: "for",
    code: "FOR",
    name: "FOR Report Publishing",
    purpose: "Produce and publish recurring forecast-oriented reports for the Blockchain Economics Lab.",
    cadence: "Recurring report cycle",
    pipelineOwnerName: "CRO",
    nodes: [],
    edges: [],
  },
  {
    key: "website",
    code: "WEB",
    name: "BCELab Website Development and Operations",
    purpose: "Develop, deploy, operate, and improve the BCELab website that publishes report outputs and product-facing pages.",
    cadence: "Change-driven development with continuous post-deploy monitoring",
    statePageKind: "website",
    pipelineOwnerName: "CTO",
    nodes: [
      {
        key: "change_request_intake",
        kind: "input",
        label: "Website change request intake",
        description: "Receive board requests, pipeline incidents, report visibility gaps, or product improvement requests that require website code or configuration changes.",
        ownerName: "CEO",
      },
      {
        key: "impact_and_scope_review",
        kind: "agent_task",
        label: "Impact and scope review",
        description: "Identify affected pages, data contracts, report surfaces, deployment risks, and whether the change touches ECON, MAT, FOR, score, project, or report routes.",
        ownerName: "CTO",
      },
      {
        key: "temporary_workspace_implementation",
        kind: "agent_task",
        label: "Temporary workspace implementation",
        description: "Implement the website change in an isolated workspace so the production pipeline and current website remain undisturbed during development.",
        ownerName: "FullStackEngineer",
      },
      {
        key: "pipeline_definition_alignment",
        kind: "agent_task",
        label: "Pipeline definition alignment check",
        description: "Confirm the temporary workspace code matches the pipeline definition and does not create hidden behavior outside the approved website and report pipelines.",
        ownerName: "CTO",
      },
      {
        key: "quality_and_build_verification",
        kind: "approval",
        label: "Quality and build verification",
        description: "Run typecheck, tests, and production build. Verify important pages and report surfaces render the expected ECON, MAT, FOR, and website outputs.",
        ownerName: "CTO",
      },
      {
        key: "board_deployment_approval",
        kind: "approval",
        label: "Board deployment approval",
        description: "Request board approval with evidence from the temporary workspace, alignment check, test results, and known operational risks.",
        ownerName: "CEO",
      },
      {
        key: "production_deployment",
        kind: "output",
        label: "Production deployment",
        description: "Commit, push, and deploy the approved website change to production through the configured deployment path.",
        ownerName: "FullStackEngineer",
      },
      {
        key: "post_deploy_monitoring",
        kind: "monitor",
        label: "Post-deploy monitoring",
        description: "Check production pages, report visibility, deployment health, analytics/errors, and create follow-up issues for regressions or improvement opportunities.",
        ownerName: "COO",
      },
    ],
    edges: [
      ["change_request_intake", "impact_and_scope_review"],
      ["impact_and_scope_review", "temporary_workspace_implementation"],
      ["temporary_workspace_implementation", "pipeline_definition_alignment"],
      ["pipeline_definition_alignment", "quality_and_build_verification"],
      ["quality_and_build_verification", "board_deployment_approval"],
      ["board_deployment_approval", "production_deployment"],
      ["production_deployment", "post_deploy_monitoring"],
    ],
  },
];

for (const spec of PIPELINES) {
  if (spec.nodes.length === 0) spec.nodes = PIPELINES[0].nodes;
  if (spec.edges.length === 0) spec.edges = PIPELINES[0].edges;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function api<T>(baseUrl: string, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${route} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) as T : undefined as T;
}

function findAgent(agents: Agent[], name: string): Agent | null {
  return agents.find((agent) => agent.name.toLowerCase() === name.toLowerCase()) ?? null;
}

function diagram(spec: PipelineSpec): string {
  const lines = ["flowchart LR"];
  for (const node of spec.nodes) {
    lines.push(`  ${node.key}["${node.label.replaceAll("\"", "'")}"]`);
  }
  for (const [source, target] of spec.edges) {
    lines.push(`  ${source} --> ${target}`);
  }
  return lines.join("\n");
}

async function ensurePipeline(
  baseUrl: string,
  companyId: string,
  spec: PipelineSpec,
  existing: Pipeline[],
  ownerAgentId: string | null,
  apply: boolean,
): Promise<Pipeline | null> {
  const found = existing.find((pipeline) => pipeline.name === spec.name);
  if (found) {
    if (apply && found.ownerAgentId !== ownerAgentId) {
      return api<Pipeline>(baseUrl, `/pipelines/${found.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ownerAgentId }),
      });
    }
    return found;
  }
  if (!apply) {
    console.log(`[dry-run] create pipeline: ${spec.name}`);
    return null;
  }
  return api<Pipeline>(baseUrl, `/companies/${companyId}/pipelines`, {
    method: "POST",
    body: JSON.stringify({
      name: spec.name,
      description: spec.purpose,
      ownerAgentId,
      status: "active",
      reviewStatus: "active",
      ownerAssignmentStatus: "partially_assigned",
      healthStatus: "unknown",
      diagramFormat: "mermaid",
      diagramSource: diagram(spec),
      metadata: {
        migration: "bcelab-pipeline-first",
        reportCode: spec.code,
        statePage: `knowledge/pipelines/${spec.key}.md`,
      },
    }),
  });
}

async function ensureNodesAndEdges(
  baseUrl: string,
  pipelineId: string,
  spec: PipelineSpec,
  agents: Agent[],
  apply: boolean,
): Promise<PipelineDetail | null> {
  if (!apply) {
    console.log(`[dry-run] create ${spec.nodes.length} nodes and ${spec.edges.length} edges for ${spec.name}`);
    return null;
  }
  let detail = await api<PipelineDetail>(baseUrl, `/pipelines/${pipelineId}`);
  const nodesByKey = new Map(detail.nodes.map((node) => [node.nodeKey, node]));

  for (const node of spec.nodes) {
    if (nodesByKey.has(node.key)) continue;
    const owner = node.ownerName ? findAgent(agents, node.ownerName) : null;
    const created = await api<PipelineNode>(baseUrl, `/pipelines/${pipelineId}/nodes`, {
      method: "POST",
      body: JSON.stringify({
        nodeKey: node.key,
        kind: node.kind,
        label: node.label,
        description: node.description,
        linkedEntityType: owner ? "agent" : undefined,
        linkedEntityId: owner?.id,
        healthStatus: "unknown",
      }),
    });
    nodesByKey.set(created.nodeKey, created);
  }

  detail = await api<PipelineDetail>(baseUrl, `/pipelines/${pipelineId}`);
  const existingEdges = new Set(detail.edges.map((edge) => `${edge.sourceNodeId}:${edge.targetNodeId}`));
  const finalNodesByKey = new Map(detail.nodes.map((node) => [node.nodeKey, node]));
  for (const [sourceKey, targetKey, label] of spec.edges) {
    const source = finalNodesByKey.get(sourceKey);
    const target = finalNodesByKey.get(targetKey);
    if (!source || !target) throw new Error(`Missing edge nodes for ${spec.name}: ${sourceKey} -> ${targetKey}`);
    const edgeKey = `${source.id}:${target.id}`;
    if (existingEdges.has(edgeKey)) continue;
    await api(baseUrl, `/pipelines/${pipelineId}/edges`, {
      method: "POST",
      body: JSON.stringify({
        sourceNodeId: source.id,
        targetNodeId: target.id,
        label: label ?? null,
      }),
    });
  }

  return api<PipelineDetail>(baseUrl, `/pipelines/${pipelineId}`);
}

function statePage(spec: PipelineSpec): string {
  if (spec.statePageKind === "website") {
    return [
      `# ${spec.name}`,
      "",
      "## Purpose",
      "",
      spec.purpose,
      "",
      "## Current Diagram",
      "",
      "```mermaid",
      diagram(spec),
      "```",
      "",
      "## Operating State",
      "",
      "- Cadence: Change-driven development with continuous post-deploy monitoring",
      "- Health: unknown",
      "- Source repository: BCELab website repository",
      "- Development mode: temporary workspace first",
      "- Required pre-approval check: temporary workspace code must match the pipeline definition being approved",
      "- Required verification: typecheck, tests, production build, and page-level report visibility checks",
      "- Deployment gate: board approval before production deployment",
      "- Production surfaces: homepage, score/top-200 pages, project pages, report listing pages, report detail pages, APIs, and scheduled pipeline integrations",
      "",
      "## Inputs",
      "",
      "- Board requests for website behavior or product changes",
      "- Pipeline incidents, missing report visibility, broken report cards, stale pages, or deployment failures",
      "- Changes required by ECON, MAT, FOR, or future report pipelines",
      "- Monitoring signals from production pages and scheduled jobs",
      "",
      "## Outputs",
      "",
      "- Reviewed and approved website code changes",
      "- Production deployment with a clear commit and deployment record",
      "- Verified website behavior for affected pages and report types",
      "- Post-deploy monitoring notes and follow-up issues",
      "",
      "## Owners",
      "",
      "- Pipeline owner: CTO",
      "- Intake and prioritization: CEO",
      "- Impact and scope review: CTO",
      "- Implementation and deployment: FullStackEngineer",
      "- Board deployment approval request: CEO",
      "- Post-deploy monitoring: COO",
      "",
      "## Known Risks",
      "",
      "- Uncommitted or undeployed code can make local verification diverge from production behavior.",
      "- Report data can exist in storage while website filters, status rules, or cached pages hide it from users.",
      "- A website fix can accidentally change ECON, MAT, and FOR surfaces differently unless all affected report types are checked together.",
      "- Deployment should not proceed if the temporary workspace code does not match the approved pipeline definition.",
      "- Production cache, scheduled jobs, and database status fields can make successful code changes appear ineffective unless monitored after deployment.",
      "",
      "## Open Changes",
      "",
      "- TODO: Link active Paperclip issues here.",
      "",
      "## Update Rule",
      "",
      "Agents must update this page when website behavior, deployment rules, owners, dependencies, health, monitoring, or operating rules change.",
      "",
    ].join("\n");
  }

  return [
    `# ${spec.name}`,
    "",
    "## Purpose",
    "",
    spec.purpose,
    "",
    "## Current Diagram",
    "",
    "```mermaid",
    diagram(spec),
    "```",
    "",
    "## Operating State",
    "",
    `- Report code: ${spec.code}`,
    `- Cadence: ${spec.cadence}`,
    "- Health: unknown",
    `- Slide PDF intake folder: Google Drive Slide/${spec.code}`,
    `- Markdown source folder: Google Drive analysis/${spec.code}`,
    "- Summary/marketing localization target: 7 languages",
    "- Summary/marketing localization provider: TODO",
    "- Full report body translation: not part of the current operating pipeline",
    "- Website publishing target: TODO",
    "",
    "## Inputs",
    "",
    `- New slide-form PDF in Google Drive Slide/${spec.code}`,
    `- Matching .md source in Google Drive analysis/${spec.code}`,
    "",
    "## Outputs",
    "",
    "- Published report page that exposes the PDF/report asset",
    "- Extracted summary and marketing copy exposed on the website",
    "- 7-language localized summary and marketing copy exposed on the website",
    "- Publication notes and incident follow-ups",
    "",
    "## Owners",
    "",
    "- Pipeline owner: CRO",
    "- Slide PDF intake and source checks: DataPlatformEngineer",
    "- Markdown source validation and copy extraction: CRO",
    "- 7-language summary/marketing localization and website integration: FullStackEngineer",
    "- Editorial gate and operations monitoring: COO",
    "",
    "## Known Risks",
    "",
    "- Summary/marketing localization provider changes can alter teaser terminology and campaign copy in 7 languages.",
    "- Treat full report translation as a new pipeline change request, not as current baseline behavior.",
    "- A new PDF without a matching .md source should block publication.",
    "- Website publishing changes can break report URLs or layout.",
    "- Missing source data should block publication rather than producing a weak report.",
    "",
    "## Open Changes",
    "",
    "- TODO: Link active Paperclip issues here.",
    "",
    "## Update Rule",
    "",
    "Agents must update this page when behavior, ownership, dependencies, health, monitoring, or operating rules change.",
    "",
  ].join("\n");
}

async function writeStatePages(stateDir: string, apply: boolean): Promise<void> {
  if (!apply) {
    console.log(`[dry-run] write state pages to ${stateDir}`);
    return;
  }
  await fs.mkdir(stateDir, { recursive: true });
  for (const spec of PIPELINES) {
    const target = path.join(stateDir, `${spec.key}.md`);
    try {
      await fs.access(target);
      console.log(`state page exists: ${target}`);
    } catch {
      await fs.writeFile(target, statePage(spec), "utf8");
      console.log(`created state page: ${target}`);
    }
  }
}

async function patchAgentOwnership(
  baseUrl: string,
  agents: Agent[],
  apply: boolean,
): Promise<void> {
  const assignments: Array<{ name: string; ownership: Record<string, unknown> }> = [
    {
      name: "CEO",
      ownership: {
        pipelineName: "BCELab operating pipeline portfolio",
        pipelineRole: "Pipeline Architecture Owner",
        responsibilities: [
          "Keep ECON, MAT, FOR, and website operations aligned to company strategy",
          "Assign owners for missing pipeline nodes",
          "Escalate cross-pipeline blockers",
        ],
      },
    },
    {
      name: "CTO",
      ownership: {
        pipelineName: "BCELab Website Development and Operations",
        pipelineRole: "Website Pipeline Owner",
        responsibilities: [
          "Own impact review for website changes",
          "Confirm temporary workspace code matches the approved pipeline definition before deployment approval",
          "Require typecheck, tests, build, and page-level verification before production deployment",
        ],
      },
    },
    {
      name: "CRO",
      ownership: {
        pipelineName: "ECON/MAT/FOR report portfolio",
        pipelineRole: "Research Report Portfolio Owner",
        responsibilities: [
          "Own report logic, claims, and research quality",
          "Review source synthesis and report drafts",
          "Escalate weak evidence before publication",
        ],
      },
    },
    {
      name: "COO",
      ownership: {
        pipelineName: "ECON/MAT/FOR publishing operations and website post-deploy monitoring",
        pipelineRole: "Publishing Operations Owner",
        responsibilities: [
          "Own review cadence and release readiness",
          "Monitor blocked or degraded report publication and website post-deploy steps",
          "Coordinate state page updates after incidents",
        ],
      },
    },
    {
      name: "DataPlatformEngineer",
      ownership: {
        pipelineName: "ECON/MAT/FOR source collection",
        pipelineNodeKey: "source_collection",
        pipelineRole: "Source Collection Node Owner",
        responsibilities: [
          "Maintain source collection automation",
          "Document upstream data dependencies and failures",
        ],
      },
    },
    {
      name: "FullStackEngineer",
      ownership: {
        pipelineName: "ECON/MAT/FOR website publishing and BCELab website deployment",
        pipelineNodeKey: "website_publish",
        pipelineRole: "Publishing and Localization Integration Node Owner",
        responsibilities: [
          "Maintain summary/marketing localization and website publishing integration",
          "Implement approved website changes in a temporary workspace before production deployment",
          "Preserve report URLs, formatting, and publication health",
        ],
      },
    },
  ];

  for (const assignment of assignments) {
    const agent = findAgent(agents, assignment.name);
    if (!agent) {
      console.log(`agent not found for ownership assignment: ${assignment.name}`);
      continue;
    }
    const metadata = {
      ...(agent.metadata ?? {}),
      pipelineOwnership: assignment.ownership,
    };
    if (!apply) {
      console.log(`[dry-run] patch ${agent.name} metadata.pipelineOwnership`);
      continue;
    }
    await api(baseUrl, `/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ metadata }),
    });
    console.log(`patched ${agent.name} pipeline ownership`);
  }
}

async function main() {
  const apply = hasArg("--apply");
  const baseUrl = (argValue("--base-url") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const companyIdArg = argValue("--company-id");
  const companyName = argValue("--company-name") ?? DEFAULT_COMPANY_NAME;
  const stateDirArg = argValue("--state-dir") ?? DEFAULT_STATE_DIR;
  const stateDir = path.isAbsolute(stateDirArg) ? stateDirArg : path.resolve(REPO_ROOT, stateDirArg);
  const skipAgentMetadata = hasArg("--skip-agent-metadata");

  const companies = await api<Company[]>(baseUrl, "/companies");
  const company = companyIdArg
    ? companies.find((entry) => entry.id === companyIdArg)
    : companies.find((entry) => entry.name === companyName);
  if (!company) {
    throw new Error(`Company not found: ${companyIdArg ?? companyName}`);
  }

  console.log(`${apply ? "Applying" : "Dry run"} BCELab pipeline migration for ${company.name} (${company.id})`);

  const [agents, existingPipelines] = await Promise.all([
    api<Agent[]>(baseUrl, `/companies/${company.id}/agents`),
    api<Pipeline[]>(baseUrl, `/companies/${company.id}/pipelines`),
  ]);

  const createdOrExisting: Pipeline[] = [];
  for (const spec of PIPELINES) {
    const owner = spec.pipelineOwnerName ? findAgent(agents, spec.pipelineOwnerName) : null;
    const pipeline = await ensurePipeline(baseUrl, company.id, spec, existingPipelines, owner?.id ?? null, apply);
    if (pipeline) createdOrExisting.push(pipeline);
  }

  for (const spec of PIPELINES) {
    const pipeline = createdOrExisting.find((entry) => entry.name === spec.name);
    if (!pipeline) continue;
    await ensureNodesAndEdges(baseUrl, pipeline.id, spec, agents, apply);
  }

  await writeStatePages(stateDir, apply);
  if (!skipAgentMetadata) {
    await patchAgentOwnership(baseUrl, agents, apply);
  }

  if (!apply) {
    console.log("Dry run complete. Re-run with --apply to persist changes.");
  } else {
    console.log("BCELab pipeline migration complete.");
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
