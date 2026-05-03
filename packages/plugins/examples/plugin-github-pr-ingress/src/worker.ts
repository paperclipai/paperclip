import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";

const WEBHOOK_KEY = "github-pull-request";
const ORIGIN_KIND = "plugin:keegoid.plugin-github-pr-ingress:github-pr" as const;

type IssuePriority = Issue["priority"];
type IssueStatus = Issue["status"];

const BILLING_CODE = "github-pr-review";
const DEFAULT_PRIORITY: IssuePriority = "medium";
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const TITLE_PREFIX = "[code-change]";
const WEBHOOK_UNAVAILABLE_MESSAGE = "GitHub webhook handler is unavailable";

type RepoMapping = {
  repository: string;
  companyId: string;
  projectId?: string;
  parentIssueId?: string;
  assigneeAgentId?: string;
  priority?: IssuePriority;
};

type GithubIngressConfig = {
  githubWebhookSecretRef?: string;
  repositories?: RepoMapping[];
};

type GithubRepository = {
  full_name?: unknown;
  html_url?: unknown;
};

type GithubPullRequest = {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  state?: unknown;
  draft?: unknown;
  merged?: unknown;
  user?: { login?: unknown } | null;
  head?: {
    ref?: unknown;
    sha?: unknown;
    repo?: GithubRepository | null;
  } | null;
  base?: {
    ref?: unknown;
    repo?: GithubRepository | null;
  } | null;
};

type GithubPullRequestPayload = {
  action?: unknown;
  repository?: GithubRepository | null;
  pull_request?: GithubPullRequest | null;
};

type SyncResult = {
  action: "created" | "updated" | "ignored" | "duplicate";
  issueId?: string;
  reason?: string;
};

type RuntimeState = {
  ctx: PluginContext;
  lastDelivery: Record<string, unknown> | null;
  lastPrSync: Record<string, unknown> | null;
};

// The host starts one independent worker process per installed plugin, so this
// process-local runtime is scoped to a single configured plugin instance.
let runtime: RuntimeState | null = null;

function currentRuntime(): RuntimeState {
  if (!runtime) throw new Error("Plugin context is not initialized");
  return runtime;
}

function recordLastDelivery(value: Record<string, unknown>): void {
  currentRuntime().lastDelivery = value;
}

function recordLastPrSync(value: Record<string, unknown>): void {
  currentRuntime().lastPrSync = value;
}

function stateKeyForDelivery(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}

function stateKeyForPullRequest(repoFullName: string, prNumber: number): string {
  return `pr:${repoFullName.toLowerCase()}#${prNumber}`;
}

function firstHeader(headers: Record<string, string | string[]>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value;
  }
  return null;
}

function assertWebhookBodySize(rawBody: string): void {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error(`GitHub webhook payload is too large; max ${MAX_WEBHOOK_BODY_BYTES} bytes`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function normalizeRepoName(value: string): string {
  return value.trim().toLowerCase();
}

function isIssuePriority(value: unknown): value is IssuePriority {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function sanitizeMapping(input: unknown): RepoMapping | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const repository = stringValue(raw.repository);
  const companyId = stringValue(raw.companyId);
  if (!repository || !companyId) return null;
  return {
    repository,
    companyId,
    projectId: stringValue(raw.projectId) ?? undefined,
    parentIssueId: stringValue(raw.parentIssueId) ?? undefined,
    assigneeAgentId: stringValue(raw.assigneeAgentId) ?? undefined,
    priority: isIssuePriority(raw.priority) ? raw.priority : DEFAULT_PRIORITY,
  };
}

function sanitizeConfig(input: Record<string, unknown>): GithubIngressConfig {
  const repositories = Array.isArray(input.repositories)
    ? input.repositories.map(sanitizeMapping).filter((value): value is RepoMapping => value !== null)
    : [];
  return {
    githubWebhookSecretRef: stringValue(input.githubWebhookSecretRef) ?? undefined,
    repositories,
  };
}

function mappingForRepository(config: GithubIngressConfig, repoFullName: string): RepoMapping | null {
  const normalized = normalizeRepoName(repoFullName);
  return (config.repositories ?? []).find((mapping) => normalizeRepoName(mapping.repository) === normalized) ?? null;
}

function hasGithubSignatureHeader(value: string | null): boolean {
  return typeof value === "string" && value.startsWith("sha256=");
}

function isSyncedDeliveryState(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const action = (value as Record<string, unknown>).action;
  return action === "created" || action === "updated";
}

export function verifyGithubSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  if (secret.length === 0) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const actual = signatureHeader.trim();
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parsePayload(rawBody: string): GithubPullRequestPayload {
  try {
    return JSON.parse(rawBody) as GithubPullRequestPayload;
  } catch (error) {
    throw new Error(`Invalid GitHub webhook JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function issueStatusForPullRequest(action: string, pr: GithubPullRequest): IssueStatus {
  if (action === "closed") return pr.merged === true ? "done" : "cancelled";
  if (pr.draft === true) return "backlog";
  return "todo";
}

function issueTitle(repoFullName: string, prNumber: number, title: string): string {
  return `${TITLE_PREFIX} ${repoFullName}#${prNumber}: ${title}`;
}

function buildIssueDescription(input: {
  action: string;
  repoFullName: string;
  repoUrl: string | null;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  pr: GithubPullRequest;
}): string {
  const author = stringValue(input.pr.user?.login) ?? "unknown";
  const headRepo = stringValue(input.pr.head?.repo?.full_name) ?? input.repoFullName;
  const headRef = stringValue(input.pr.head?.ref) ?? "unknown";
  const headSha = stringValue(input.pr.head?.sha) ?? "unknown";
  const baseRef = stringValue(input.pr.base?.ref) ?? "unknown";
  const repoLink = input.repoUrl ? `[${input.repoFullName}](${input.repoUrl})` : `\`${input.repoFullName}\``;

  return [
    "GitHub pull request observed by the GitHub PR Ingress plugin.",
    "",
    `- Repository: ${repoLink}`,
    `- Pull request: [#${input.prNumber} ${input.prTitle}](${input.prUrl})`,
    `- Last webhook action: \`${input.action}\``,
    `- PR state: \`${stringValue(input.pr.state) ?? "unknown"}\``,
    `- Draft: \`${input.pr.draft === true ? "true" : "false"}\``,
    `- Merged: \`${input.pr.merged === true ? "true" : "false"}\``,
    `- Author: \`${author}\``,
    `- Head: \`${headRepo}:${headRef}\``,
    `- Head SHA: \`${headSha}\``,
    `- Base: \`${baseRef}\``,
    "",
    "Review routing is handled by the post-D4 opposite-model review routine.",
  ].join("\n");
}

function buildUpdateComment(input: {
  action: string;
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  deliveryId: string;
  nextStatus: IssueStatus;
}): string {
  return [
    `GitHub PR webhook \`${input.action}\` received for [${input.repoFullName}#${input.prNumber}](${input.prUrl}).`,
    "",
    `- Delivery: \`${input.deliveryId}\``,
    `- Synced status: \`${input.nextStatus}\``,
  ].join("\n");
}

async function readConfig(ctx: PluginContext): Promise<GithubIngressConfig> {
  return sanitizeConfig(await ctx.config.get());
}

async function resolveWebhookSecret(ctx: PluginContext, config: GithubIngressConfig): Promise<string> {
  if (!config.githubWebhookSecretRef) {
    throw new Error(WEBHOOK_UNAVAILABLE_MESSAGE);
  }
  const secret = await ctx.secrets.resolve(config.githubWebhookSecretRef);
  if (!secret) {
    throw new Error(WEBHOOK_UNAVAILABLE_MESSAGE);
  }
  return secret;
}

function configHealth(config: GithubIngressConfig): Pick<PluginHealthDiagnostics, "status" | "message"> & {
  details: {
    secretRefConfigured: boolean;
    repositoriesConfigured: number;
  };
} {
  const secretRefConfigured = Boolean(config.githubWebhookSecretRef);
  const repositoriesConfigured = config.repositories?.length ?? 0;
  const ready = secretRefConfigured && repositoriesConfigured > 0;
  return {
    status: ready ? "ok" : "degraded",
    message: ready
      ? "GitHub PR ingress is configured"
      : "GitHub PR ingress needs a webhook secret ref and at least one repository mapping",
    details: {
      secretRefConfigured,
      repositoriesConfigured,
    },
  };
}

async function healthDiagnostics(ctx: PluginContext | null): Promise<PluginHealthDiagnostics> {
  if (!ctx) {
    return {
      status: "error",
      message: "Plugin context is not initialized",
      details: {
        lastDelivery: runtime?.lastDelivery ?? null,
        lastPrSync: runtime?.lastPrSync ?? null,
      },
    };
  }

  const health = configHealth(await readConfig(ctx));
  return {
    ...health,
    details: {
      ...health.details,
      lastDelivery: runtime?.lastDelivery ?? null,
      lastPrSync: runtime?.lastPrSync ?? null,
    },
  };
}

async function syncPullRequest(
  ctx: PluginContext,
  payload: GithubPullRequestPayload,
  mapping: RepoMapping,
  deliveryId: string,
): Promise<SyncResult> {
  const action = stringValue(payload.action);
  const repoFullName = stringValue(payload.repository?.full_name);
  const pr = payload.pull_request;
  const prNumber = numberValue(pr?.number);
  const prTitle = stringValue(pr?.title);
  const prUrl = stringValue(pr?.html_url);

  if (!action || !repoFullName || !pr || prNumber === null || !prTitle || !prUrl) {
    throw new Error("GitHub pull_request payload is missing required fields");
  }

  const originId = `${repoFullName}#${prNumber}`;
  const nextStatus = issueStatusForPullRequest(action, pr);
  const description = buildIssueDescription({
    action,
    repoFullName,
    repoUrl: stringValue(payload.repository?.html_url),
    prNumber,
    prTitle,
    prUrl,
    pr,
  });
  const existing = await ctx.issues.list({
    companyId: mapping.companyId,
    originKind: ORIGIN_KIND,
    originId,
    limit: 2,
    offset: 0,
  });
  if (existing.length > 1) {
    ctx.logger.warn("Multiple Paperclip issues share one GitHub PR origin", {
      originKind: ORIGIN_KIND,
      originId,
      issueIds: existing.map((issue) => issue.id),
    });
  }

  const issueFields = {
    title: issueTitle(repoFullName, prNumber, prTitle),
    description,
    status: nextStatus,
    priority: mapping.priority ?? DEFAULT_PRIORITY,
    billingCode: BILLING_CODE,
    ...(mapping.assigneeAgentId ? { assigneeAgentId: mapping.assigneeAgentId } : {}),
  };

  const issue = existing[0]
    ? await ctx.issues.update(existing[0].id, issueFields, mapping.companyId)
    : await ctx.issues.create({
      companyId: mapping.companyId,
      projectId: mapping.projectId,
      parentId: mapping.parentIssueId,
      ...issueFields,
      originKind: ORIGIN_KIND,
      originId,
    });

  if (existing[0]) {
    await ctx.issues.createComment(
      issue.id,
      buildUpdateComment({ action, repoFullName, prNumber, prUrl, deliveryId, nextStatus }),
      mapping.companyId,
    );
  }

  const summary = {
    issueId: issue.id,
    repoFullName,
    prNumber,
    prUrl,
    action,
    status: nextStatus,
    deliveryId,
    syncedAt: new Date().toISOString(),
  };
  await ctx.state.set({ scopeKind: "instance", stateKey: stateKeyForPullRequest(repoFullName, prNumber) }, summary);
  recordLastPrSync(summary);
  return { action: existing[0] ? "updated" : "created", issueId: issue.id };
}

async function handlePullRequestWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<SyncResult> {
  if (input.endpointKey !== WEBHOOK_KEY) {
    throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
  }

  const deliveryId = firstHeader(input.headers, "x-github-delivery") ?? input.requestId;
  const deliveryStateKey = stateKeyForDelivery(deliveryId);
  assertWebhookBodySize(input.rawBody);
  const signature = firstHeader(input.headers, "x-hub-signature-256");
  if (!hasGithubSignatureHeader(signature)) {
    throw new Error("Invalid GitHub webhook signature");
  }
  const config = await readConfig(ctx);
  const secret = await resolveWebhookSecret(ctx, config);
  if (!verifyGithubSignature(input.rawBody, signature, secret)) {
    throw new Error("Invalid GitHub webhook signature");
  }

  const priorDelivery = await ctx.state.get({ scopeKind: "instance", stateKey: deliveryStateKey });
  if (isSyncedDeliveryState(priorDelivery)) {
    return { action: "duplicate", reason: `delivery ${deliveryId} was already processed` };
  }
  if (priorDelivery) {
    // Only successful PR syncs are terminal idempotency records. Old ignored
    // records are removed so GitHub retries can sync after mappings change.
    await ctx.state.delete({ scopeKind: "instance", stateKey: deliveryStateKey });
  }

  const event = firstHeader(input.headers, "x-github-event");
  if (event !== "pull_request") {
    const ignored = {
      action: "ignored",
      reason: `unsupported event ${event ?? "unknown"}`,
      deliveryId,
      processedAt: new Date().toISOString(),
    };
    recordLastDelivery(ignored);
    return { action: "ignored", reason: ignored.reason };
  }

  const payload = parsePayload(input.rawBody);
  const repoFullName = stringValue(payload.repository?.full_name);
  if (!repoFullName) {
    throw new Error("GitHub webhook payload is missing repository.full_name");
  }

  const mapping = mappingForRepository(config, repoFullName);
  if (!mapping) {
    const ignored = {
      action: "ignored",
      reason: `repository ${repoFullName} is not mapped`,
      deliveryId,
      processedAt: new Date().toISOString(),
    };
    recordLastDelivery(ignored);
    return { action: "ignored", reason: ignored.reason };
  }

  const result = await syncPullRequest(ctx, payload, mapping, deliveryId);
  const deliverySummary = {
    ...result,
    deliveryId,
    repository: repoFullName,
    processedAt: new Date().toISOString(),
  };
  await ctx.state.set({ scopeKind: "instance", stateKey: deliveryStateKey }, deliverySummary);
  recordLastDelivery(deliverySummary);
  return result;
}

const plugin = definePlugin({
  async setup(ctx) {
    runtime = {
      ctx,
      lastDelivery: null,
      lastPrSync: null,
    };

    ctx.data.register("health", async () => {
      const diagnostics = await healthDiagnostics(ctx);
      return {
        ...diagnostics,
        checkedAt: new Date().toISOString(),
      };
    });
  },

  async onValidateConfig(config) {
    const typed = sanitizeConfig(config);
    const errors: string[] = [];
    if (!typed.githubWebhookSecretRef) errors.push("githubWebhookSecretRef is required");
    if ((typed.repositories ?? []).length === 0) errors.push("at least one repository mapping is required");
    return { ok: errors.length === 0, errors, warnings: [] };
  },

  async onWebhook(input) {
    await handlePullRequestWebhook(currentRuntime().ctx, input);
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return healthDiagnostics(runtime?.ctx ?? null);
  },
});

export {
  MAX_WEBHOOK_BODY_BYTES,
  ORIGIN_KIND,
  WEBHOOK_KEY,
  handlePullRequestWebhook,
  stateKeyForDelivery,
  stateKeyForPullRequest,
};
export default plugin;
runWorker(plugin, import.meta.url);
