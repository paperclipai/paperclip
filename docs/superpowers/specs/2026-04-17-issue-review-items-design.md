# Issue Review Items Design

Date: 2026-04-17
Status: Approved for implementation

## Goal

Turn issue detail into a premium review surface that promotes every detectable item in the issue into a structured, actionable review board without losing comment-level provenance.

## Problem

Today the issue detail experience is optimized for raw markdown comments and attachments. This creates several review failures:

- plain URLs often remain buried in prose
- workspace file paths are inert text
- uploaded images are visible only in the attachments section, not where they matter
- work products, documents, attachments, and references live in separate surfaces with no unified ranking
- humans must scan the thread linearly to find what needs review

`ATHA-15` is the representative example: long assistant comments contain marketplace text, file paths such as `ops/cocktail-machine-sale/listing-templates/wallapop.txt`, and references to assets that are hard to inspect quickly.

## Design Direction

The issue page should default to a **review board first** layout:

1. Full-width review board at the top
2. Thread remains below as supporting context
3. Clicking a review card opens a shared right-side drawer or modal

This optimizes for fast actionable insights while preserving provenance.

## Information Architecture

All detectable items normalize into a shared `ReviewItem` model and appear in three groups:

### 1. Review Now

Items that are immediately inspectable or decision-worthy:

- image attachments and markdown image embeds
- uploaded files and issue documents with previews
- marketplace links
- preview URLs
- pull requests, branches, commits, runtime services, and other work products
- generic external URLs with usable previews or clear destinations

### 2. References

Supporting items that matter but are usually secondary:

- workspace file paths
- generic URLs without richer metadata
- repeated supporting artifacts already represented elsewhere

### 3. Hidden Context

Collapsed by default:

- duplicates
- stale mentions
- unresolved or unavailable items
- low-value references that should remain visible but not compete with primary review

## Ranking

Within each group, items rank by:

1. previewable before non-previewable
2. explicit outputs before raw references
3. unresolved/review-needed before already-reviewed
4. newest mention first
5. duplicates collapsed into one canonical item with mention count and latest provenance

## Card Types

Every item renders as one of these card families:

### Image

- thumbnail-first
- mention count if deduped
- opens image preview in drawer/lightbox

### File / Document

- filename and path
- type badge
- preview snippet or first heading for text/markdown
- image preview for safe image files

### Marketplace Link

- domain-specialized presentation for Wallapop, Milanuncios, eBay, Exapro, Machineseeker, and similar
- strong hostname/title treatment even when remote metadata is unavailable

### Work Product

- provider badge
- status / review state
- actions tailored to PRs, preview URLs, runtime services, branches, or commits

### Generic Link

- normalized hostname and path
- safe fallback presentation even without enrichment

### Missing / Unavailable

- visible warning state
- never silently dropped
- still includes source comment and mention details

## Drawer Behavior

Clicking a card opens a shared detail drawer with this order:

1. Preview
2. Direct actions (`Open`, `Jump to source`, `Mark reviewed` when relevant)
3. Provenance (`source comment`, `last mentioned by`, `mention count`, `latest timestamp`)
4. Raw reference data if preview is limited

## Comment Rendering

The thread remains readable and compact:

- raw URLs should render as links
- detected items should render as compact chips/cards beneath the comment body
- comments should not expand into giant embedded previews inline by default
- inline previews and top-level review cards must share the same normalized item model

## Data Model

Introduce a shared normalized item representation for issue review surfaces.

Illustrative shape:

```ts
type ReviewItemGroup = "review_now" | "references" | "hidden_context";
type ReviewItemKind =
  | "image"
  | "file"
  | "document"
  | "marketplace_link"
  | "work_product"
  | "generic_link"
  | "missing";

interface ReviewItemSourceRef {
  sourceType: "issue_description" | "issue_comment" | "attachment" | "document" | "work_product";
  sourceId: string;
  commentId?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt: string;
}

interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  group: ReviewItemGroup;
  title: string;
  subtitle: string | null;
  summary: string | null;
  previewState: "ready" | "partial" | "missing" | "unsupported";
  status: "new" | "reviewed" | "stale" | "unavailable";
  thumbnailUrl: string | null;
  resolvedTarget: {
    url?: string | null;
    path?: string | null;
    attachmentId?: string | null;
    documentKey?: string | null;
    workProductId?: string | null;
  };
  sourceRefs: ReviewItemSourceRef[];
  mentionCount: number;
  metadata: Record<string, unknown> | null;
}
```

## Detection Sources

The review board should be built from:

- issue description
- issue comments
- issue attachments
- issue documents
- issue work products

Detection rules:

- markdown links and images
- plain URLs in text
- workspace-style file paths
- known marketplace domains
- work products and documents already present in first-class data

## Preview Resolution

Resolution must be tiered and non-blocking:

### Immediate local resolution

- attachments
- issue documents
- work products
- workspace files through a new safe preview endpoint

### Optional async enrichment

- remote URL metadata for link cards

Cards must render immediately from local detection. Async enrichment can improve them later but must never control visibility.

## Workspace File Preview API

Add a safe issue-scoped file preview API for paths detected in comments.

Requirements:

- only resolve under the issue project's `effectiveLocalFolder`
- reject traversal and paths outside the project root
- hard cap file size and preview bytes
- support text/markdown snippet previews
- support image previews for safe image file types
- unsupported binaries return metadata-only responses
- company access and issue/company scoping remain enforced

This is necessary to make workspace paths first-class review items instead of inert text.

## Failure Handling

- Detection failure must degrade to a visible fallback item, not disappearance.
- File preview failures must fail closed and return a structured unavailable state.
- Async URL enrichment failures must not block board rendering.
- If review item extraction fails entirely, the issue page still loads normally and shows a local board error state.

## Testing

Required verification coverage:

- parser tests for URL, markdown image/link, marketplace link, workspace path, and dedupe behavior
- safe file preview route tests for project scoping and traversal rejection
- UI tests for grouping, ranking, inline chips, hidden-context collapse, and unavailable items
- issue detail integration coverage for merged board + thread rendering

## Non-Goals

- no fully general crawler-based URL unfurling requirement in V1
- no inline expansion of every preview directly inside comment prose
- no arbitrary repo browsing UI beyond the bounded preview endpoint
