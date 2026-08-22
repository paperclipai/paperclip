import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { GitHubClient } from "../auth.js";
import type { ResolvedConfig } from "../config.js";
import { RefusalError } from "../audit.js";
import { getPr, type GetPrResult } from "./pr.js";

export interface EnqueueMergeParams {
  prNumber: number;
}

const ENQUEUE_MUTATION = /* GraphQL */ `
  mutation ($prId: ID!) {
    enqueuePullRequest(input: { pullRequestId: $prId }) {
      mergeQueueEntry {
        position
        enqueuedAt
        state
      }
    }
  }
`;

const PR_ID_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
      }
    }
  }
`;

interface PrIdResp {
  repository: { pullRequest: { id: string } };
}

interface EnqueueResp {
  enqueuePullRequest: {
    mergeQueueEntry: {
      position: number;
      enqueuedAt: string;
      state: string;
    } | null;
  };
}

export async function enqueueMerge(
  client: GitHubClient,
  cfg: ResolvedConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseEnqueueMerge(params);

  if (!cfg.mergeQueueEnabled) {
    throw new RefusalError("merge_queue_disabled", "mergeQueueEnabled=false in plugin config");
  }

  // Re-read PR status: if failing checks remain, refuse rather than letting
  // the queue spin and bounce the entry. "no merge without evidence".
  const prStatusResult = await getPr(client, { prNumber: p.prNumber }, runCtx);
  if (prStatusResult.error) {
    return prStatusResult;
  }
  const prStatus = prStatusResult.data as GetPrResult;

  if (prStatus.draft) {
    throw new RefusalError("pr_is_draft", `PR #${p.prNumber} is still draft`);
  }
  if (prStatus.state !== "OPEN") {
    throw new RefusalError("pr_not_open", `PR #${p.prNumber} state=${prStatus.state}`);
  }
  if (prStatus.failingChecks.length > 0) {
    throw new RefusalError(
      "failing_checks",
      `PR #${p.prNumber} has failing checks: ${prStatus.failingChecks.slice(0, 5).join(", ")}`,
    );
  }
  if (prStatus.reviewDecision !== null && prStatus.reviewDecision !== "APPROVED") {
    throw new RefusalError(
      "review_not_approved",
      `PR #${p.prNumber} reviewDecision=${prStatus.reviewDecision}`,
    );
  }

  const idResp = await client.graphql<PrIdResp>(PR_ID_QUERY, {
    owner: client.owner,
    repo: client.name,
    number: p.prNumber,
  });
  const prId = idResp.repository.pullRequest.id;

  const resp = await client.graphql<EnqueueResp>(ENQUEUE_MUTATION, { prId });
  const entry = resp.enqueuePullRequest.mergeQueueEntry;
  if (!entry) {
    throw new RefusalError("enqueue_no_entry", "GitHub returned no merge queue entry");
  }

  return {
    content: `PR #${p.prNumber} enqueued at position ${entry.position}`,
    data: { queuedAt: entry.enqueuedAt, position: entry.position, state: entry.state },
  };
}

function parseEnqueueMerge(params: unknown): EnqueueMergeParams {
  if (typeof params !== "object" || params === null) throw new Error("enqueueMerge: params must be an object");
  const p = params as Record<string, unknown>;
  if (typeof p.prNumber !== "number") throw new Error("prNumber required");
  return { prNumber: p.prNumber };
}
