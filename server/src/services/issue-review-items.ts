import path from "node:path";
import type {
  IssueAttachment,
  IssueBoardState,
  IssueComment,
  IssueDocument,
  IssueReviewActionTarget,
  IssueReviewBlocker,
  IssueReviewHint,
  IssueReviewItem,
  IssueReviewItemGroup,
  IssueReviewItemKind,
  IssueReviewPack,
  IssueReviewPackSurface,
  IssueReviewItemPreviewState,
  IssueReviewItemSourceRef,
  IssueReviewItemStatus,
  IssueWorkProduct,
} from "@paperclipai/shared";

interface BuildIssueReviewItemsInput {
  issueId: string;
  issueDescription: string | null;
  hasProjectCodebase: boolean;
  comments: readonly IssueComment[];
  attachments: readonly IssueAttachment[];
  documents: readonly IssueDocument[];
  workProducts: readonly IssueWorkProduct[];
}

interface MutableReviewItem extends IssueReviewItem {
  latestTouchedAt: number;
}

interface BuildIssueReviewPackSurfaceInput {
  issueId: string;
  issueTitle: string;
  issueDescription: string | null;
  reviewItems: readonly IssueReviewItem[];
  boardState: IssueBoardState | null;
}

const GROUP_RANK: Record<IssueReviewItemGroup, number> = {
  review_now: 0,
  references: 1,
  hidden_context: 2,
};

const KIND_RANK: Record<IssueReviewItemKind, number> = {
  work_product: 0,
  image: 1,
  document: 2,
  marketplace_link: 3,
  generic_link: 4,
  file: 5,
  missing: 6,
};

const MARKETPLACE_DOMAINS = [
  "wallapop.com",
  "milanuncios.com",
  "ebay.es",
  "ebay.com",
  "exapro.com",
  "machineseeker.com",
];

const MARKETPLACE_FILE_TOKENS = ["wallapop", "milanuncios", "ebay", "ebay-es", "exapro", "machineseeker", "b2b"];
const LISTING_EVIDENCE_TOKENS = ["checklist", "readme", "master-listing", "master_listing", "publication", "template"];

const MARKDOWN_LINK_RE = /!?\[([^\]]*)\]\(([^)]+)\)/g;
const PLAIN_URL_RE = /https?:\/\/[^\s)]+/g;
const WORKSPACE_PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}\b/g;

function basename(value: string) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.split("/").at(-1) ?? trimmed;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isMarketplaceUrl(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return MARKETPLACE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function trimTrailingUrlPunctuation(value: string) {
  return value.replace(/[),.!?]+$/g, "");
}

function sourceTimestamp(ref: IssueReviewItemSourceRef) {
  return ref.createdAt instanceof Date ? ref.createdAt.getTime() : new Date(ref.createdAt).getTime();
}

function coerceDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function mergeGroup(current: IssueReviewItemGroup, next: IssueReviewItemGroup): IssueReviewItemGroup {
  return GROUP_RANK[next] < GROUP_RANK[current] ? next : current;
}

function mergePreviewState(
  current: IssueReviewItemPreviewState,
  next: IssueReviewItemPreviewState,
): IssueReviewItemPreviewState {
  const rank: Record<IssueReviewItemPreviewState, number> = {
    ready: 0,
    partial: 1,
    unsupported: 2,
    missing: 3,
  };
  return rank[next] < rank[current] ? next : current;
}

function mergeStatus(current: IssueReviewItemStatus, next: IssueReviewItemStatus): IssueReviewItemStatus {
  const rank: Record<IssueReviewItemStatus, number> = {
    new: 0,
    reviewed: 1,
    stale: 2,
    unavailable: 3,
  };
  return rank[next] > rank[current] ? next : current;
}

function filePathItemState(hasProjectCodebase: boolean) {
  if (hasProjectCodebase) {
    return {
      group: "references" as const,
      previewState: "partial" as const,
      status: "new" as const,
    };
  }
  return {
    group: "hidden_context" as const,
    previewState: "missing" as const,
    status: "unavailable" as const,
  };
}

function appendSource(item: MutableReviewItem, ref: IssueReviewItemSourceRef) {
  const duplicate = item.sourceRefs.some(
    (existing) =>
      existing.sourceType === ref.sourceType
      && existing.sourceId === ref.sourceId
      && existing.commentId === ref.commentId,
  );
  if (!duplicate) {
    item.sourceRefs.push(ref);
    item.mentionCount = item.sourceRefs.length;
  }
  item.latestTouchedAt = Math.max(item.latestTouchedAt, sourceTimestamp(ref));
}

function upsert(
  map: Map<string, MutableReviewItem>,
  key: string,
  next: Omit<MutableReviewItem, "mentionCount" | "latestTouchedAt" | "sourceRefs"> & {
    sourceRef: IssueReviewItemSourceRef;
  },
) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      ...next,
      sourceRefs: [next.sourceRef],
      mentionCount: 1,
      latestTouchedAt: sourceTimestamp(next.sourceRef),
    });
    return;
  }

  existing.group = mergeGroup(existing.group, next.group);
  existing.previewState = mergePreviewState(existing.previewState, next.previewState);
  existing.status = mergeStatus(existing.status, next.status);
  if (!existing.thumbnailUrl && next.thumbnailUrl) existing.thumbnailUrl = next.thumbnailUrl;
  if (!existing.summary && next.summary) existing.summary = next.summary;
  if (!existing.subtitle && next.subtitle) existing.subtitle = next.subtitle;
  existing.metadata = existing.metadata ?? next.metadata;
  existing.resolvedTarget = { ...next.resolvedTarget, ...existing.resolvedTarget };
  appendSource(existing, next.sourceRef);
}

function urlSourceKey(url: string) {
  return `url:${url}`;
}

function pathSourceKey(filePath: string) {
  return `path:${filePath}`;
}

function attachmentSourceKey(attachmentId: string) {
  return `attachment:${attachmentId}`;
}

function documentSourceKey(documentId: string) {
  return `document:${documentId}`;
}

function workProductSourceKey(workProductId: string) {
  return `work_product:${workProductId}`;
}

function commentSourceRef(comment: IssueComment): IssueReviewItemSourceRef {
  return {
    sourceType: "issue_comment",
    sourceId: comment.id,
    commentId: comment.id,
    authorAgentId: comment.authorAgentId,
    authorUserId: comment.authorUserId,
    createdAt: coerceDate(comment.createdAt),
  };
}

function issueDescriptionSourceRef(issueId: string): IssueReviewItemSourceRef {
  return {
    sourceType: "issue_description",
    sourceId: issueId,
    createdAt: new Date(0),
  };
}

function collectMarkdownTargets(text: string) {
  const matches = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const target = match[2]?.trim();
    if (!target) continue;
    const trimmedTarget = trimTrailingUrlPunctuation(target);
    if (!trimmedTarget.startsWith("http://") && !trimmedTarget.startsWith("https://")) continue;
    matches.add(trimmedTarget);
  }
  return matches;
}

function collectPlainUrls(text: string, knownTargets: Set<string>) {
  const matches = new Set<string>();
  for (const match of text.matchAll(PLAIN_URL_RE)) {
    const value = trimTrailingUrlPunctuation(match[0] ?? "");
    if (!value || knownTargets.has(value)) continue;
    matches.add(value);
  }
  return matches;
}

function collectWorkspacePaths(text: string) {
  const matches = new Set<string>();
  for (const match of text.matchAll(WORKSPACE_PATH_RE)) {
    const value = match[0]?.trim();
    if (!value || value.startsWith("http://") || value.startsWith("https://")) continue;
    matches.add(value);
  }
  return matches;
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function stripExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function basenameForItem(item: IssueReviewItem) {
  if (item.resolvedTarget.path) return basename(item.resolvedTarget.path);
  if (item.subtitle) return basename(item.subtitle);
  return basename(item.title);
}

function looksLikeListingTask(issueTitle: string, issueDescription: string | null) {
  const haystack = `${normalizeText(issueTitle)} ${normalizeText(issueDescription)}`;
  return haystack.includes("listing") || haystack.includes("publish");
}

function isMarketplaceOutputFile(item: IssueReviewItem) {
  if (item.kind !== "file") return false;
  const candidate = normalizeText(stripExtension(basenameForItem(item)));
  return MARKETPLACE_FILE_TOKENS.some((token) => candidate.includes(token));
}

function isListingEvidenceFile(item: IssueReviewItem) {
  if (item.kind !== "file" && item.kind !== "document") return false;
  const candidate = normalizeText(stripExtension(basenameForItem(item)));
  return LISTING_EVIDENCE_TOKENS.some((token) => candidate.includes(token));
}

function combineSourceRefs(items: readonly IssueReviewItem[]) {
  const refs = new Map<string, IssueReviewItemSourceRef>();
  for (const item of items) {
    for (const sourceRef of item.sourceRefs) {
      const key = `${sourceRef.sourceType}:${sourceRef.sourceId}:${sourceRef.commentId ?? ""}`;
      if (!refs.has(key)) {
        refs.set(key, sourceRef);
      }
    }
  }
  return [...refs.values()].sort((left, right) => sourceTimestamp(right) - sourceTimestamp(left));
}

function sumMentionCount(items: readonly IssueReviewItem[]) {
  return items.reduce((total, item) => total + item.mentionCount, 0);
}

function reviewActionForItem(item: IssueReviewItem): IssueReviewActionTarget {
  const latestSource = item.sourceRefs[0] ?? null;
  if (latestSource?.commentId) {
    return { type: "item", value: item.id };
  }
  return { type: "item", value: item.id };
}

function summarizePack(primaryItems: readonly IssueReviewItem[], evidenceItems: readonly IssueReviewItem[]) {
  if (primaryItems.length > 1 && evidenceItems.length > 0) {
    return `${primaryItems.length} primary outputs with ${evidenceItems.length} supporting assets.`;
  }
  if (primaryItems.length > 1) {
    return `${primaryItems.length} related outputs grouped for review.`;
  }
  const first = primaryItems[0];
  if (!first) return null;
  return first.summary ?? first.subtitle ?? null;
}

function derivePackTitle(issueTitle: string) {
  const trimmed = issueTitle.trim();
  if (!trimmed) return "Review pack";
  const base = trimmed.split(":")[0]?.trim() || trimmed;
  if (base.toLowerCase().endsWith("pack")) return base;
  return `${base} pack`;
}

function deriveSingleItemPackReason(item: IssueReviewItem) {
  switch (item.kind) {
    case "work_product":
      return "Primary work product surfaced for review.";
    case "image":
      return "Image artifact surfaced for review.";
    case "marketplace_link":
      return "External listing link surfaced for review.";
    case "document":
      return "Document output surfaced for review.";
    case "file":
      return "File output surfaced for review.";
    default:
      return "Reviewable asset surfaced for inspection.";
  }
}

function buildHints(input: {
  issueTitle: string;
  issueDescription: string | null;
  reviewItems: readonly IssueReviewItem[];
  primaryItems: readonly IssueReviewItem[];
  listingLike: boolean;
}): IssueReviewHint[] {
  const hints: IssueReviewHint[] = [];
  const hasLinkLikeTarget = input.reviewItems.some((item) =>
    (item.kind === "marketplace_link" || item.kind === "work_product" || item.kind === "generic_link")
      && Boolean(item.resolvedTarget.url),
  );
  const hasImages = input.reviewItems.some((item) => item.kind === "image");
  const hasPreviewablePrimary = input.primaryItems.some((item) =>
    item.previewState === "ready"
      || Boolean(item.thumbnailUrl)
      || Boolean(item.resolvedTarget.path)
      || item.kind === "document",
  );

  if (input.listingLike && !hasLinkLikeTarget) {
    hints.push({
      code: "missing_live_links",
      label: "Live links not detected",
      severity: "warning",
      detail: "No preview URL or marketplace link was detected in the issue context yet.",
    });
  }
  if (input.listingLike && !hasImages) {
    hints.push({
      code: "no_visible_images",
      label: "No visible images",
      severity: "warning",
      detail: "No image attachments were detected for this review pack.",
    });
  }
  if (!hasPreviewablePrimary) {
    hints.push({
      code: "missing_previewable_artifact",
      label: "No inline preview for the primary deliverable",
      severity: "info",
      detail: "The current primary outputs require drawer inspection instead of showing a ready preview.",
    });
  }
  return hints;
}

function derivePackStatus(primaryItems: readonly IssueReviewItem[], hints: readonly IssueReviewHint[]) {
  if (hints.some((hint) => hint.severity === "critical")) return "blocked" as const;
  if (hints.some((hint) => hint.severity === "warning")) return "warning" as const;
  if (primaryItems.every((item) => item.status === "reviewed")) return "reviewed" as const;
  return "ready" as const;
}

function materialBoardStateSummary(boardState: IssueBoardState) {
  switch (boardState.kind) {
    case "system_error":
      return "Fix the issue state or add the missing dependency before treating this review pack as complete.";
    case "blocked":
      if (boardState.reasonCode === "capability_blocked") {
        return "This review pack cannot advance because the required specialist role is unavailable.";
      }
      return "A real dependency is still blocking review completion. Resolve the blocker before closing the loop.";
    default:
      return null;
  }
}

function buildBlockers(boardState: IssueBoardState | null): IssueReviewBlocker[] {
  if (!boardState) return [];
  if (boardState.kind !== "blocked" && boardState.kind !== "system_error") return [];
  return [
    {
      id: `board-state:${boardState.kind}`,
      title: boardState.headline,
      summary: materialBoardStateSummary(boardState),
      actionLabel: boardState.primaryAction?.label ?? null,
      actionTarget: boardState.primaryAction
        ? {
            type: boardState.primaryAction.targetEntity,
            value: boardState.primaryAction.targetId,
          }
        : null,
      severity: boardState.kind === "system_error" ? "critical" : "warning",
    },
  ];
}

function createPack(input: {
  id: string;
  title: string;
  reason: string;
  primaryItems: readonly IssueReviewItem[];
  evidenceItems?: readonly IssueReviewItem[];
  hints?: readonly IssueReviewHint[];
  nextActionLabel?: string | null;
}): IssueReviewPack {
  const primaryItems = [...input.primaryItems];
  const evidenceItems = [...(input.evidenceItems ?? [])];
  const sourceRefs = combineSourceRefs([...primaryItems, ...evidenceItems]);
  const hints = [...(input.hints ?? [])];
  return {
    id: input.id,
    title: input.title,
    summary: summarizePack(primaryItems, evidenceItems),
    reason: input.reason,
    primaryItemIds: primaryItems.map((item) => item.id),
    evidenceItemIds: evidenceItems.map((item) => item.id),
    warningCodes: hints.map((hint) => hint.code),
    hints,
    status: derivePackStatus(primaryItems, hints),
    nextActionLabel: input.nextActionLabel ?? (primaryItems.length > 1 ? "Review outputs" : "Inspect deliverable"),
    nextActionTarget: primaryItems[0] ? reviewActionForItem(primaryItems[0]) : null,
    mentionCount: sumMentionCount([...primaryItems, ...evidenceItems]),
    sourceRefs,
  };
}

function rankPackCandidate(item: IssueReviewItem) {
  let score = 0;

  if (item.group === "review_now") score += 100;
  if (item.group === "references") score += 40;

  switch (item.kind) {
    case "work_product":
      score += 80;
      break;
    case "marketplace_link":
      score += 70;
      break;
    case "image":
      score += 60;
      break;
    case "document":
      score += 50;
      break;
    case "generic_link":
      score += 40;
      break;
    case "file":
      score += 30;
      break;
    default:
      break;
  }

  switch (item.previewState) {
    case "ready":
      score += 12;
      break;
    case "partial":
      score += 8;
      break;
    case "unsupported":
      score += 2;
      break;
    case "missing":
      score -= 5;
      break;
  }

  if (item.resolvedTarget.url) score += 10;
  if (item.resolvedTarget.path) score += 8;
  if (item.thumbnailUrl) score += 10;
  if (item.status === "unavailable") score -= 50;

  score += Math.min(item.mentionCount, 5);
  return score;
}

export function buildIssueReviewPackSurface(input: BuildIssueReviewPackSurfaceInput): IssueReviewPackSurface | null {
  const reviewableItems = input.reviewItems.filter((item) => item.group !== "hidden_context");
  const blockers = buildBlockers(input.boardState);

  if (reviewableItems.length === 0) {
    return blockers.length > 0
      ? { blockers, heroPack: null, queue: [], evidence: [] }
      : null;
  }

  const usedItemIds = new Set<string>();
  const fileItemsByDirectory = new Map<string, IssueReviewItem[]>();
  for (const item of reviewableItems) {
    if (!item.resolvedTarget.path) continue;
    const directory = path.dirname(item.resolvedTarget.path);
    const existing = fileItemsByDirectory.get(directory) ?? [];
    existing.push(item);
    fileItemsByDirectory.set(directory, existing);
  }

  const listingLike = looksLikeListingTask(input.issueTitle, input.issueDescription);
  let heroPack: IssueReviewPack | null = null;

  const listingGroup = [...fileItemsByDirectory.values()]
    .map((group) => ({
      primaryItems: group.filter(isMarketplaceOutputFile),
      evidenceItems: group.filter((item) => !isMarketplaceOutputFile(item) && isListingEvidenceFile(item)),
    }))
    .filter((group) => group.primaryItems.length >= 2)
    .sort((left, right) => {
      if (left.primaryItems.length !== right.primaryItems.length) {
        return right.primaryItems.length - left.primaryItems.length;
      }
      return right.evidenceItems.length - left.evidenceItems.length;
    })[0];

  if (listingGroup) {
    const hints = buildHints({
      issueTitle: input.issueTitle,
      issueDescription: input.issueDescription,
      reviewItems: input.reviewItems,
      primaryItems: listingGroup.primaryItems,
      listingLike: true,
    });
    heroPack = createPack({
      id: `pack:${input.issueId}:hero`,
      title: derivePackTitle(input.issueTitle),
      reason: `${listingGroup.primaryItems.length} marketplace outputs grouped from the same listing workspace.`,
      primaryItems: listingGroup.primaryItems,
      evidenceItems: listingGroup.evidenceItems,
      hints,
      nextActionLabel: "Inspect primary outputs",
    });
  } else {
    const primaryItem = [...reviewableItems]
      .sort((left, right) => {
        const scoreDiff = rankPackCandidate(right) - rankPackCandidate(left);
        if (scoreDiff !== 0) return scoreDiff;
        return left.title.localeCompare(right.title);
      })[0] ?? null;
    if (primaryItem) {
      const evidenceItems = reviewableItems
        .filter((item) => item.group === "references" && item.id !== primaryItem.id)
        .slice(0, 3);
      const hints = buildHints({
        issueTitle: input.issueTitle,
        issueDescription: input.issueDescription,
        reviewItems: input.reviewItems,
        primaryItems: [primaryItem],
        listingLike,
      });
      heroPack = createPack({
        id: `pack:${input.issueId}:hero`,
        title: derivePackTitle(input.issueTitle),
        reason: primaryItem.kind === "file" || primaryItem.kind === "document"
          ? "Primary deliverable chosen from the strongest review target in this issue."
          : "Primary review target surfaced from the current issue context.",
        primaryItems: [primaryItem],
        evidenceItems,
        hints,
        nextActionLabel: "Inspect primary deliverable",
      });
    }
  }

  if (heroPack) {
    for (const itemId of heroPack.primaryItemIds) usedItemIds.add(itemId);
    for (const itemId of heroPack.evidenceItemIds) usedItemIds.add(itemId);
  }

  const queue = reviewableItems
    .filter((item) => !usedItemIds.has(item.id))
    .sort((left, right) => {
      const scoreDiff = rankPackCandidate(right) - rankPackCandidate(left);
      if (scoreDiff !== 0) return scoreDiff;
      return left.title.localeCompare(right.title);
    })
    .map((item, index) =>
      createPack({
        id: `pack:${input.issueId}:queue:${index}:${item.id}`,
        title: item.title,
        reason: deriveSingleItemPackReason(item),
        primaryItems: [item],
      }),
    );

  for (const pack of queue) {
    for (const itemId of pack.primaryItemIds) usedItemIds.add(itemId);
  }

  const evidence = reviewableItems
    .filter((item) => item.group === "references" && !usedItemIds.has(item.id))
    .map((item) => item.id);

  return {
    blockers,
    heroPack,
    queue,
    evidence,
  };
}

export function buildIssueReviewItems(input: BuildIssueReviewItemsInput): IssueReviewItem[] {
  const items = new Map<string, MutableReviewItem>();

  for (const attachment of input.attachments) {
    const kind: IssueReviewItemKind = attachment.contentType.startsWith("image/") ? "image" : "file";
    upsert(items, attachmentSourceKey(attachment.id), {
      id: attachmentSourceKey(attachment.id),
      kind,
      group: "review_now",
      title: attachment.originalFilename ?? attachment.id,
      subtitle: kind === "image" ? "Image attachment" : attachment.contentType,
      summary: null,
      previewState: attachment.contentType.startsWith("image/") ? "ready" : "partial",
      status: "new",
      thumbnailUrl: attachment.contentType.startsWith("image/") ? attachment.contentPath : null,
      resolvedTarget: {
        attachmentId: attachment.id,
        url: attachment.contentPath,
      },
      metadata: {
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
      sourceRef: {
        sourceType: "attachment",
        sourceId: attachment.id,
        commentId: attachment.issueCommentId,
        authorAgentId: attachment.createdByAgentId,
        authorUserId: attachment.createdByUserId,
        createdAt: coerceDate(attachment.createdAt),
      },
    });
  }

  for (const document of input.documents) {
    upsert(items, documentSourceKey(document.id), {
      id: documentSourceKey(document.id),
      kind: "document",
      group: "review_now",
      title: document.title ?? document.key,
      subtitle: document.key,
      summary: document.body.split(/\r?\n/).find((line) => line.trim().length > 0 && !line.startsWith("#")) ?? null,
      previewState: "ready",
      status: "new",
      thumbnailUrl: null,
      resolvedTarget: {
        documentKey: document.key,
      },
      metadata: {
        latestRevisionNumber: document.latestRevisionNumber,
        format: document.format,
      },
      sourceRef: {
        sourceType: "document",
        sourceId: document.id,
        authorAgentId: document.updatedByAgentId,
        authorUserId: document.updatedByUserId,
        createdAt: coerceDate(document.updatedAt),
      },
    });
  }

  for (const workProduct of input.workProducts) {
    upsert(items, workProductSourceKey(workProduct.id), {
      id: workProductSourceKey(workProduct.id),
      kind: "work_product",
      group: "review_now",
      title: workProduct.title,
      subtitle: workProduct.type,
      summary: workProduct.summary,
      previewState: workProduct.url ? "ready" : "partial",
      status: workProduct.reviewState === "needs_board_review" ? "new" : "reviewed",
      thumbnailUrl: null,
      resolvedTarget: {
        workProductId: workProduct.id,
        url: workProduct.url,
      },
      metadata: {
        type: workProduct.type,
        provider: workProduct.provider,
        reviewState: workProduct.reviewState,
        status: workProduct.status,
      },
      sourceRef: {
        sourceType: "work_product",
        sourceId: workProduct.id,
        createdAt: coerceDate(workProduct.updatedAt),
      },
    });
  }

  const textSources = [
    input.issueDescription
      ? {
          body: input.issueDescription,
          sourceRef: issueDescriptionSourceRef(input.issueId),
        }
      : null,
    ...input.comments.map((comment) => ({
      body: comment.body,
      sourceRef: commentSourceRef(comment),
    })),
  ].filter((value): value is { body: string; sourceRef: IssueReviewItemSourceRef } => Boolean(value));

  for (const source of textSources) {
    const markdownTargets = collectMarkdownTargets(source.body);
    const urls = new Set([
      ...markdownTargets,
      ...collectPlainUrls(source.body, markdownTargets),
    ]);
    const paths = collectWorkspacePaths(source.body);

    for (const rawUrl of urls) {
      const url = parseUrl(rawUrl);
      if (!url) continue;

      const attachment = input.attachments.find((candidate) => candidate.contentPath === rawUrl);
      if (attachment) {
        upsert(items, attachmentSourceKey(attachment.id), {
          ...(items.get(attachmentSourceKey(attachment.id)) as MutableReviewItem),
          sourceRef: source.sourceRef,
        });
        continue;
      }

      const workProduct = input.workProducts.find((candidate) => candidate.url === rawUrl);
      if (workProduct) {
        upsert(items, workProductSourceKey(workProduct.id), {
          ...(items.get(workProductSourceKey(workProduct.id)) as MutableReviewItem),
          sourceRef: source.sourceRef,
        });
        continue;
      }

      const isMarketplace = isMarketplaceUrl(url);
      upsert(items, urlSourceKey(rawUrl), {
        id: urlSourceKey(rawUrl),
        kind: isMarketplace ? "marketplace_link" : "generic_link",
        group: isMarketplace ? "review_now" : "references",
        title: isMarketplace ? url.hostname.replace(/^www\./, "") : url.hostname.replace(/^www\./, ""),
        subtitle: url.pathname === "/" ? rawUrl : `${url.hostname.replace(/^www\./, "")}${url.pathname}`,
        summary: null,
        previewState: "ready",
        status: "new",
        thumbnailUrl: null,
        resolvedTarget: { url: rawUrl },
        metadata: null,
        sourceRef: source.sourceRef,
      });
    }

    for (const filePath of paths) {
      const { group, previewState, status } = filePathItemState(input.hasProjectCodebase);
      upsert(items, pathSourceKey(filePath), {
        id: pathSourceKey(filePath),
        kind: "file",
        group,
        title: basename(filePath),
        subtitle: filePath,
        summary: null,
        previewState,
        status,
        thumbnailUrl: null,
        resolvedTarget: { path: filePath },
        metadata: {
          extension: path.extname(filePath),
        },
        sourceRef: source.sourceRef,
      });
    }
  }

  return [...items.values()]
    .sort((left, right) => {
      const groupDiff = GROUP_RANK[left.group] - GROUP_RANK[right.group];
      if (groupDiff !== 0) return groupDiff;

      const kindDiff = KIND_RANK[left.kind] - KIND_RANK[right.kind];
      if (kindDiff !== 0) return kindDiff;

      if (left.latestTouchedAt !== right.latestTouchedAt) {
        return right.latestTouchedAt - left.latestTouchedAt;
      }

      return left.title.localeCompare(right.title);
    })
    .map(({ latestTouchedAt: _latestTouchedAt, ...item }) => item);
}
