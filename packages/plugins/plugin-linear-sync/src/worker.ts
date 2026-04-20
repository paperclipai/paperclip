import {
  definePlugin,
  runWorker,
  startWorkerRpcHost,
  type PluginContext,
  type PluginWebhookInput,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import type { PluginJobContext } from "@paperclipai/plugin-sdk";
import {
  ENTITY_TYPE,
  JOB_KEYS,
  LINEAR_API,
  LINEAR_TEAM_ID,
  LINEAR_TO_PAPERCLIP_STATUS,
  PAPERCLIP_TO_LINEAR_STATE,
  STATE_KEYS,
  TOOL_NAMES,
} from "./constants.js";
import type { Issue } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LinearConfig = {
  linearApiKey: string;
  teamId: string;
  syncIntervalMinutes: number;
  enableOutboundSync: boolean;
};

async function getConfig(ctx: PluginContext): Promise<LinearConfig> {
  const raw = (await ctx.config.get()) as Partial<LinearConfig>;
  return {
    linearApiKey: raw.linearApiKey ?? "env:LINEAR_API_KEY",
    teamId: raw.teamId ?? LINEAR_TEAM_ID,
    syncIntervalMinutes: raw.syncIntervalMinutes ?? 10,
    enableOutboundSync: raw.enableOutboundSync ?? true,
  };
}

async function resolveApiKey(ctx: PluginContext, config: LinearConfig): Promise<string> {
  const key = await ctx.secrets.resolve(config.linearApiKey);
  if (!key) throw new Error("Linear API key not configured");
  return key;
}

async function linearGraphQL(
  ctx: PluginContext,
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const resp = await ctx.http.fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`Linear API error ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0]!.message}`);
  }
  return json.data;
}

/** Discover the first company visible to this plugin instance. */
async function getCompanyId(ctx: PluginContext): Promise<string> {
  const companies = await ctx.companies.list({ limit: 1 });
  if (!companies.length) throw new Error("No company found");
  return companies[0]!.id;
}

// ---------------------------------------------------------------------------
// Inbound sync: Linear → Paperclip
// ---------------------------------------------------------------------------

const ISSUES_QUERY = `
  query TeamIssues($teamId: String!, $after: String, $updatedAfter: DateTimeOrDuration) {
    team(id: $teamId) {
      issues(
        first: 50,
        after: $after,
        filter: {
          updatedAt: { gte: $updatedAfter },
          state: { type: { nin: ["completed", "canceled"] } }
        },
        orderBy: createdAt
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          identifier
          title
          description
          priority
          state { name }
          labels { nodes { name } }
          assignee { name }
          createdAt
          updatedAt
          url
        }
      }
    }
  }
`;

type LinearIssueNode = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  assignee: { name: string } | null;
  createdAt: string;
  updatedAt: string;
  url: string;
};

type PaperclipPriority = "critical" | "high" | "medium" | "low";
type IssueStatus = "backlog" | "in_progress" | "done" | "cancelled" | "todo" | "in_review" | "blocked";

const LINEAR_LINK_MARKER = "**Linear:** https://linear.app/";
const PAGE_SIZE = 100;

function linearPriorityToPaperclip(p: number): PaperclipPriority {
  switch (p) {
    case 1: return "critical";
    case 2: return "high";
    case 3: return "medium";
    case 4: return "low";
    default: return "medium";
  }
}

function paperclipPriorityToLinear(priority: Issue["priority"] | null | undefined): number | null {
  switch (priority) {
    case "critical": return 1;
    case "high": return 2;
    case "medium": return 3;
    case "low": return 4;
    default: return null;
  }
}

function normalizePaperclipStatus(status: string | null | undefined): IssueStatus {
  return (status ?? "todo") as IssueStatus;
}

function buildLinearTitle(issue: Issue): string {
  const identifier = issue.identifier?.trim();
  if (!identifier) return issue.title;
  const prefix = `[${identifier}]`;
  return issue.title.startsWith(prefix) ? issue.title : `${prefix} ${issue.title}`;
}

function buildLinearDescription(issue: Issue): string {
  const sections = [issue.description?.trim() ?? ""].filter(Boolean);
  const identifier = issue.identifier?.trim();
  sections.push("---");
  sections.push(`**Paperclip:** ${identifier ?? issue.id}`);
  sections.push(`**Paperclip Issue ID:** ${issue.id}`);
  return sections.join("\n\n");
}

function isImportedLinearIssue(issue: Issue): boolean {
  const description = issue.description ?? "";
  return description.includes(LINEAR_LINK_MARKER);
}

async function listAllIssues(ctx: PluginContext, companyId: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  let offset = 0;

  while (true) {
    const page = await ctx.issues.list({ companyId, limit: PAGE_SIZE, offset });
    issues.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  return issues;
}

async function upsertLinearLink(
  ctx: PluginContext,
  paperclipIssue: Issue,
  linearIssue: LinearIssueNode,
): Promise<void> {
  const labels = linearIssue.labels.nodes.map((label) => label.name);
  await ctx.entities.upsert({
    entityType: ENTITY_TYPE,
    scopeKind: "instance",
    externalId: linearIssue.identifier,
    title: linearIssue.title,
    status: linearIssue.state.name,
    data: {
      linearId: linearIssue.id,
      linearIdentifier: linearIssue.identifier,
      linearStatus: linearIssue.state.name,
      linearPriority: linearIssue.priority,
      linearLabels: labels,
      linearUrl: linearIssue.url,
      linearUpdatedAt: linearIssue.updatedAt,
      paperclipIssueId: paperclipIssue.id,
      paperclipIdentifier: paperclipIssue.identifier,
    },
  });

  await ctx.state.set(
    { scopeKind: "issue", scopeId: paperclipIssue.id, stateKey: "linear-id" },
    linearIssue.identifier,
  );
}

async function createLinearIssueForPaperclipIssue(
  ctx: PluginContext,
  issue: Issue,
  config: LinearConfig,
): Promise<LinearIssueNode | null> {
  if (isImportedLinearIssue(issue)) return null;

  const existingLinearId = (await ctx.state.get({
    scopeKind: "issue",
    scopeId: issue.id,
    stateKey: "linear-id",
  })) as string | null;
  if (existingLinearId) return null;

  const apiKey = await resolveApiKey(ctx, config);
  const stateId = PAPERCLIP_TO_LINEAR_STATE[normalizePaperclipStatus(issue.status)];
  const priority = paperclipPriorityToLinear(issue.priority);

  const data = (await linearGraphQL(ctx, apiKey, `
    mutation CreateIssue(
      $teamId: String!,
      $title: String!,
      $description: String,
      $priority: Float,
      $stateId: String
    ) {
      issueCreate(input: {
        teamId: $teamId,
        title: $title,
        description: $description,
        priority: $priority,
        stateId: $stateId
      }) {
        success
        issue {
          id
          identifier
          title
          description
          priority
          state { name }
          labels { nodes { name } }
          assignee { name }
          createdAt
          updatedAt
          url
        }
      }
    }
  `, {
    teamId: config.teamId,
    title: buildLinearTitle(issue),
    description: buildLinearDescription(issue),
    priority: priority ?? undefined,
    stateId: stateId ?? undefined,
  })) as {
    issueCreate?: { success?: boolean; issue?: LinearIssueNode | null } | null;
  };

  const linearIssue = data.issueCreate?.issue ?? null;
  if (!linearIssue || data.issueCreate?.success === false) {
    throw new Error(`Failed to create Linear issue for Paperclip issue ${issue.id}`);
  }

  await upsertLinearLink(ctx, issue, linearIssue);
  await ctx.issues.createComment(
    issue.id,
    `Linked Linear issue: ${linearIssue.identifier} (${linearIssue.url})`,
    issue.companyId,
  );

  return linearIssue;
}

async function syncOutbound(ctx: PluginContext): Promise<{ created: number; skipped: number }> {
  const config = await getConfig(ctx);
  if (!config.enableOutboundSync) return { created: 0, skipped: 0 };

  const lastOutbound = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.lastOutboundCursor,
  })) as string | null;

  // The steady-state outbound path is handled by real-time issue.created and issue.updated hooks.
  // Keep the scheduled job as a one-time bootstrap/backfill pass only; repeated full rescans
  // cause the worker to balloon on larger issue sets and eventually OOM.
  if (lastOutbound) {
    return { created: 0, skipped: 0 };
  }

  const companyId = await getCompanyId(ctx);
  const issues = await listAllIssues(ctx, companyId);

  let created = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (issue.hiddenAt || issue.status === "cancelled" || !issue.identifier) {
      skipped++;
      continue;
    }

    try {
      const linked = await createLinearIssueForPaperclipIssue(ctx, issue, config);
      if (linked) created++;
      else skipped++;
    } catch (error) {
      ctx.logger.error(
        `Failed outbound Linear create for Paperclip issue ${issue.identifier ?? issue.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      skipped++;
    }
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.lastOutboundCursor },
    new Date().toISOString(),
  );

  return { created, skipped };
}

async function syncInbound(ctx: PluginContext): Promise<{ created: number; updated: number; skipped: number }> {
  const config = await getConfig(ctx);
  const apiKey = await resolveApiKey(ctx, config);
  const companyId = await getCompanyId(ctx);

  const lastSync = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.lastSyncCursor,
  })) as string | null;

  let after: string | undefined;
  let hasMore = true;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  while (hasMore) {
    const data = (await linearGraphQL(ctx, apiKey, ISSUES_QUERY, {
      teamId: config.teamId,
      after,
      updatedAfter: lastSync ?? undefined,
    })) as { team: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: LinearIssueNode[] } } };

    const { nodes, pageInfo } = data.team.issues;

    for (const issue of nodes) {
      const existing = await ctx.entities.list({
        entityType: ENTITY_TYPE,
        externalId: issue.identifier,
      });

      const paperclipStatus = (LINEAR_TO_PAPERCLIP_STATUS[issue.state.name] ?? "backlog") as IssueStatus;
      const labels = issue.labels.nodes.map((l) => l.name);
      const description = [
        issue.description ?? "",
        "",
        `---`,
        `**Linear:** ${issue.url}`,
        `**Labels:** ${labels.join(", ") || "none"}`,
        `**Assignee:** ${issue.assignee?.name ?? "unassigned"}`,
      ].join("\n");

      if (existing.length > 0) {
        const entity = existing[0]!;
        const prevStatus = (entity.data as Record<string, string>)?.linearStatus;
        if (prevStatus !== issue.state.name) {
          const paperclipIssueId = (entity.data as Record<string, string>)?.paperclipIssueId;
          if (paperclipIssueId) {
            try {
              // issues.update takes (issueId, patch, companyId)
              await ctx.issues.update(paperclipIssueId, { status: paperclipStatus }, companyId);
              updated++;
            } catch {
              skipped++;
            }
          }
          await ctx.entities.upsert({
            entityType: ENTITY_TYPE,
            scopeKind: "instance",
            externalId: issue.identifier,
            title: issue.title,
            status: issue.state.name,
            data: {
              ...(entity.data as Record<string, unknown>),
              linearStatus: issue.state.name,
              linearUpdatedAt: issue.updatedAt,
            },
          });
        } else {
          skipped++;
        }
      } else {
        try {
          // issues.create takes a single params object — no status field
          const newIssue = await ctx.issues.create({
            companyId,
            title: `[${issue.identifier}] ${issue.title}`,
            description,
            priority: linearPriorityToPaperclip(issue.priority),
          });

          await upsertLinearLink(ctx, newIssue, issue);

          created++;
        } catch {
          skipped++;
        }
      }
    }

    hasMore = pageInfo.hasNextPage;
    after = pageInfo.endCursor;
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.lastSyncCursor },
    new Date().toISOString(),
  );

  return { created, updated, skipped };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    // --- Job handlers ---
    ctx.jobs.register(JOB_KEYS.inboundSync, async (_job: PluginJobContext) => {
      const result = await syncInbound(ctx);
      ctx.logger.info("Inbound sync complete", result);
    });

    ctx.jobs.register(JOB_KEYS.outboundSync, async (_job: PluginJobContext) => {
      const result = await syncOutbound(ctx);
      ctx.logger.info("Outbound sync complete", result);
    });

    // --- Event handlers for real-time outbound sync ---
    ctx.events.on("issue.created", async (event) => {
      const config = await getConfig(ctx);
      if (!config.enableOutboundSync) return;

      const issueId = event.entityId ?? String((event.payload as Record<string, unknown> | undefined)?.id ?? "");
      if (!issueId) return;

      const issue = await ctx.issues.get(issueId, event.companyId);
      if (!issue) return;

      try {
        const linked = await createLinearIssueForPaperclipIssue(ctx, issue, config);
        if (!linked) return;
        ctx.logger.info(`Created Linear issue ${linked.identifier} for Paperclip issue ${issue.identifier ?? issue.id}`);
      } catch (error) {
        ctx.logger.error(
          `Failed real-time Linear create for Paperclip issue ${issue.identifier ?? issue.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // The outbound cron will catch missed creates
      }
    });

    ctx.events.on("issue.updated", async (event) => {
      const config = await getConfig(ctx);
      if (!config.enableOutboundSync) return;

      const payload = event.payload as { id?: string; status?: string } | undefined;
      const issueId = payload?.id ?? event.entityId;
      if (!issueId || !payload?.status) return;

      const linearId = (await ctx.state.get({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: "linear-id",
      })) as string | null;

      if (!linearId) return;

      const linearStateId = PAPERCLIP_TO_LINEAR_STATE[payload.status];
      if (!linearStateId) return;

      try {
        const apiKey = await resolveApiKey(ctx, config);
        const entities = await ctx.entities.list({
          entityType: ENTITY_TYPE,
          externalId: linearId,
        });
        const entity = entities[0];
        const linearUuid = (entity?.data as Record<string, string> | undefined)?.linearId;
        if (!linearUuid) return;

        await linearGraphQL(ctx, apiKey, `
          mutation UpdateIssue($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }
        `, { id: linearUuid, stateId: linearStateId });

        ctx.logger.info(`Pushed status ${payload.status} to Linear ${linearId}`);
      } catch {
        // The outbound cron will catch missed updates
      }
    });

    // --- Agent tools ---
    // tools.register takes 3 args: (name, declaration, handler)
    ctx.tools.register(
      TOOL_NAMES.queryLinear,
      {
        displayName: "Query Linear Issues",
        description: "Query open Linear issues in Dan's Projects team.",
        parametersSchema: {
          type: "object",
          properties: {
            status: { type: "string", description: "Filter by status" },
            label: { type: "string", description: "Filter by label name" },
            limit: { type: "number", description: "Max issues to return (default 20)" },
          },
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as { status?: string; label?: string; limit?: number };
        const config = await getConfig(ctx);
        const apiKey = await resolveApiKey(ctx, config);
        const limit = p.limit ?? 20;

        const data = (await linearGraphQL(ctx, apiKey, `
          query Issues($teamId: String!) {
            team(id: $teamId) {
              issues(first: ${limit}, orderBy: createdAt,
                filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
                nodes {
                  identifier title state { name } priority
                  labels { nodes { name } } assignee { name }
                  url createdAt
                }
              }
            }
          }
        `, { teamId: config.teamId })) as {
          team: { issues: { nodes: LinearIssueNode[] } };
        };

        const issues = data.team.issues.nodes.map((n) => ({
          id: n.identifier,
          title: n.title,
          status: n.state.name,
          priority: n.priority,
          labels: n.labels.nodes.map((l) => l.name),
          assignee: n.assignee?.name ?? null,
          url: n.url,
        }));

        return { content: JSON.stringify(issues, null, 2) };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.updateLinear,
      {
        displayName: "Update Linear Issue",
        description: "Update a Linear issue's status or add a comment.",
        parametersSchema: {
          type: "object",
          properties: {
            linearId: { type: "string", description: "Linear issue identifier (e.g., DAN-123)" },
            status: { type: "string", description: "New status: backlog, in_progress, done, cancelled" },
            comment: { type: "string", description: "Comment to add to the issue" },
          },
          required: ["linearId"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as { linearId: string; status?: string; comment?: string };
        const config = await getConfig(ctx);
        const apiKey = await resolveApiKey(ctx, config);

        const entities = await ctx.entities.list({
          entityType: ENTITY_TYPE,
          externalId: p.linearId,
        });

        let linearUuid: string | undefined;
        if (entities.length > 0) {
          linearUuid = (entities[0]!.data as Record<string, string>).linearId;
        }

        if (!linearUuid) {
          return { content: `Issue ${p.linearId} not found`, error: "not_found" };
        }

        const results: string[] = [];

        if (p.status) {
          const stateId = PAPERCLIP_TO_LINEAR_STATE[p.status];
          if (stateId) {
            await linearGraphQL(ctx, apiKey, `
              mutation($id: String!, $stateId: String!) {
                issueUpdate(id: $id, input: { stateId: $stateId }) { success }
              }
            `, { id: linearUuid, stateId });
            results.push(`Status → ${p.status}`);
          }
        }

        if (p.comment) {
          await linearGraphQL(ctx, apiKey, `
            mutation($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) { success }
            }
          `, { issueId: linearUuid, body: p.comment });
          results.push("Comment added");
        }

        return { content: results.length ? results.join(", ") : "No changes made" };
      },
    );
  },

  async onWebhook(input: PluginWebhookInput) {
    const body = input.parsedBody as Record<string, unknown> | undefined;
    if (!body) return;
    // Linear webhooks are logged; the cron job handles actual sync
  },
});

export default plugin;

// Paperclip launches plugin workers under a forked Node runtime where the ESM
// entrypoint path can miss the runWorker() main-module check. Use the managed
// plugin env var as the explicit bootstrap signal in production, while keeping
// import-time side effects off for tests and static analysis.
const bootstrapEnv = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env?.PAPERCLIP_PLUGIN_ID;

if (bootstrapEnv) {
  startWorkerRpcHost({ plugin });
} else {
  runWorker(plugin, import.meta.url);
}
