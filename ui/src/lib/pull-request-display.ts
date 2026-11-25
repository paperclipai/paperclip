import type { IssueWorkProduct } from "@paperclipai/shared";

const mergeLabels = new Map<unknown, string>([
  ["clean", "Mergeable"],
  ["blocked", "Merge blocked"],
  ["behind", "Behind base"],
  ["dirty", "Has conflicts"],
  ["unstable", "Checks not passing"],
  ["has_hooks", "Mergeable with hooks"],
]);

export interface PullRequestDetails {
  headSha: string | null;
  mergeLabel: string | null;
}

export function readPullRequestDetails(
  metadata: Record<string, unknown> | null,
  open: boolean,
): PullRequestDetails | null {
  if (!open || !metadata) return null;
  const head = metadata.headSha;
  const headSha = typeof head === "string" && /^[a-f0-9]{7,64}$/i.test(head) ? head.slice(0, 7) : null;
  const mergeLabel = mergeLabels.get(metadata.mergeableState) ?? null;
  return headSha || mergeLabel ? { headSha, mergeLabel } : null;
}

export function workProductPullRequestDetails(workProduct: IssueWorkProduct): PullRequestDetails | null {
  const state = workProduct.metadata?.state;
  const status = typeof state === "string" && state.trim() ? state.trim() : workProduct.status;
  return readPullRequestDetails(workProduct.metadata, status === "open" || status === "active" || status === "draft");
}
