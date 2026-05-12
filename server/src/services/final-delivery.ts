import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import type {
  CreateIssueThreadInteraction,
  Issue,
  IssueFinalDeliveryArtifact,
  IssueFinalDeliveryDestination,
  IssueFinalDeliveryPayload,
  IssueThreadInteraction,
  IssueWorkProduct,
} from "@paperclipai/shared";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { workProductService } from "./work-products.js";

type InteractionActor = {
  agentId?: string | null;
  userId?: string | null;
};

type FinalDeliveryIssue = Pick<Issue, "id" | "companyId" | "identifier" | "title"> & {
  status: string;
  executionPolicy?: unknown;
};

type QueueOptions = {
  actor: InteractionActor;
  finalMessageMarkdown?: string | null;
  sourceRunId?: string | null;
  now?: Date;
};

type QueueDependencies = {
  findInteractionByIdempotencyKey(args: {
    issueId: string;
    companyId: string;
    idempotencyKey: string;
  }): Promise<IssueThreadInteraction | null>;
  createInteraction(
    issue: { id: string; companyId: string },
    input: CreateIssueThreadInteraction,
    actor: InteractionActor,
  ): Promise<IssueThreadInteraction>;
  listWorkProducts(issueId: string): Promise<IssueWorkProduct[]>;
};

export type IssueFinalDeliveryQueueResult =
  | { status: "queued"; interaction: IssueThreadInteraction }
  | { status: "already_queued"; interaction: IssueThreadInteraction }
  | { status: "skipped"; reason: "not_done" | "not_configured" | "disabled" };

function destinationScope(destination: IssueFinalDeliveryDestination): string {
  if (destination.platform === "telegram") {
    return ["telegram", destination.chatId, destination.threadId ?? destination.messageId ?? "root"].join(":");
  }
  return ["slack", destination.channelId, destination.threadTs ?? destination.messageTs ?? "root"].join(":");
}

export function buildIssueFinalDeliveryIdempotencyKey(
  issueId: string,
  destination: IssueFinalDeliveryDestination,
): string {
  const raw = ["issue-final-delivery", issueId, destinationScope(destination)].join(":");
  if (raw.length <= 255) return raw;

  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return ["issue-final-delivery", issueId, digest].join(":");
}

function trimForMax(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1).trimEnd() + "…";
}

function normalizeArtifactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

function summarizeDestination(destination: IssueFinalDeliveryDestination): string {
  if (destination.platform === "telegram") {
    return destination.threadId
      ? `Telegram thread ${destination.threadId}`
      : `Telegram chat ${destination.chatId}`;
  }
  return destination.threadTs
    ? `Slack thread ${destination.threadTs}`
    : `Slack channel ${destination.channelId}`;
}

function buildDefaultFinalMessage(issue: FinalDeliveryIssue, workProducts: IssueWorkProduct[]): string {
  const issueLabel = issue.identifier ?? issue.id;
  const artifactLines = workProducts.length > 0
    ? workProducts.slice(0, 10).map((artifact) => {
        const url = normalizeArtifactUrl(artifact.url);
        return url
          ? `- ${artifact.title}: ${url}`
          : `- ${artifact.title}`;
      }).join("\n")
    : "- No work products attached.";

  return `**Done:** ${issueLabel} — ${issue.title}\n\nEvidence/artifacts:\n${artifactLines}`;
}

export function createIssueFinalDeliveryPayload(args: {
  issue: FinalDeliveryIssue;
  destination: IssueFinalDeliveryDestination;
  workProducts: IssueWorkProduct[];
  finalMessageMarkdown?: string | null;
  now?: Date;
}): IssueFinalDeliveryPayload {
  const artifacts: IssueFinalDeliveryArtifact[] = args.workProducts.slice(0, 50).map((workProduct) => ({
    id: workProduct.id,
    type: trimForMax(workProduct.type, 80),
    title: trimForMax(workProduct.title, 240),
    url: normalizeArtifactUrl(workProduct.url),
    summary: workProduct.summary ? trimForMax(workProduct.summary, 1000) : null,
    isPrimary: workProduct.isPrimary,
  }));

  return {
    version: 1 as const,
    destination: args.destination,
    issue: {
      id: args.issue.id,
      identifier: args.issue.identifier ?? null,
      title: trimForMax(args.issue.title, 240),
    },
    message: {
      format: "markdown" as const,
      body: trimForMax(
        args.finalMessageMarkdown?.trim() || buildDefaultFinalMessage(args.issue, args.workProducts),
        20000,
      ),
    },
    artifacts,
    queuedAt: (args.now ?? new Date()).toISOString(),
  };
}

export function createIssueFinalDeliveryQueue(deps: QueueDependencies) {
  return {
    queueForCompletedIssue: async (
      issue: FinalDeliveryIssue,
      options: QueueOptions,
    ): Promise<IssueFinalDeliveryQueueResult> => {
      if (issue.status !== "done") {
        return { status: "skipped", reason: "not_done" };
      }

      const parsedPolicy = issue.executionPolicy
        ? issueExecutionPolicySchema.safeParse(issue.executionPolicy)
        : null;
      const finalDelivery = parsedPolicy?.success ? parsedPolicy.data.finalDelivery ?? null : null;
      if (!finalDelivery) {
        return { status: "skipped", reason: "not_configured" };
      }
      if (finalDelivery.enabled === false) {
        return { status: "skipped", reason: "disabled" };
      }

      const destination = finalDelivery.destination;
      const idempotencyKey = buildIssueFinalDeliveryIdempotencyKey(issue.id, destination);
      const existing = await deps.findInteractionByIdempotencyKey({
        issueId: issue.id,
        companyId: issue.companyId,
        idempotencyKey,
      });
      if (existing) {
        return { status: "already_queued", interaction: existing };
      }

      const workProducts = await deps.listWorkProducts(issue.id);
      const payload = createIssueFinalDeliveryPayload({
        issue,
        destination,
        workProducts,
        finalMessageMarkdown: options.finalMessageMarkdown,
        now: options.now,
      });

      const input: CreateIssueThreadInteraction = {
        kind: "final_delivery",
        continuationPolicy: "none",
        idempotencyKey,
        sourceRunId: options.sourceRunId ?? null,
        title: `Final delivery for ${issue.identifier ?? issue.id}`,
        summary: `Queued delivery to ${summarizeDestination(destination)}`,
        payload,
      };

      const interaction = await deps.createInteraction(
        { id: issue.id, companyId: issue.companyId },
        input,
        options.actor,
      );

      return { status: "queued", interaction };
    },
  };
}

export function issueFinalDeliveryService(db: Db) {
  const interactions = issueThreadInteractionService(db);
  const workProducts = workProductService(db);

  return createIssueFinalDeliveryQueue({
    findInteractionByIdempotencyKey: ({ issueId, companyId, idempotencyKey }) => interactions.findByIdempotencyKey(
      { id: issueId, companyId },
      idempotencyKey,
    ),
    createInteraction: (issue, input, actor) => interactions.create(issue, input, actor),
    listWorkProducts: (issueId) => workProducts.listForIssue(issueId),
  });
}
