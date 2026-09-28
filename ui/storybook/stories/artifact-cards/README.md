# Artifact cards

Storybook: **Explorations → Artifact cards**. Each story renders one production
card from `ui/src/components/artifacts/RichArtifactCards.tsx`. All example titles,
authors, content, filenames, repository names, and URLs live in story args.
Use **Controls** to edit values, including Markdown bodies and JSON table data.
Theme and viewport use Storybook's toolbar.

Fixed component text consists of type, action, metadata, and state labels, such
as “Pull request,” “Read document,” “Source,” and “Checks not available.” The
contents of documents, column names, and descriptions are data.

## Production data

`IssuePropertiesArtifactsTab` renders these cards through `IssueArtifactCard`.
It keeps run grouping, agent attribution, upload deduplication, document deep
links, the document editor/annotation surface, and the shared issue gallery.
Chat work-product rows and branch/runtime cards keep their existing rendering.

| Card | Source |
| --- | --- |
| Pull request | Work-product title, summary, status, and GitHub metadata (`repo`, `number`, `baseRef`, `headRef`, `additions`, `deletions`, `changedFiles`, `state`) |
| Commit | Work-product title, summary, `repo`, `sha`, `branch`, and diff counts |
| Document | Issue document body/revision, or the existing materialized Markdown attachment review document |
| Data | Authenticated attachment CSV content, parsed locally with a 1 MiB limit, at most 200 preview rows and 50 columns; downloads retain the original file |
| Image | Attachment content path, filename, optional `alt`, `width`, and `height` metadata |
| Video | Attachment content path, filename, optional `posterUrl` and `durationLabel` metadata; native playback controls |
| Link preview | Preview work-product URL, title, summary, optional `imageUrl` and `imageAlt` metadata |
| File | Filename, MIME type, recorded byte size, original browser-open and download paths |

External file URLs (including signed query strings) are preserved unchanged.
File cards retain a separate browser-open action for inline formats such as PDF.

Missing summaries and counts stay absent. Unknown PR state/checks stay unknown.
Optional producer metadata `checks` (`passed`, `pending`, `failed`),
`reviewSummary`, and `evidenceSource` appears only when supplied. These are
recorded values, not a new live GitHub check or review integration. Runtime health
is never inferred from a URL. No remote page is scraped to manufacture a preview. Optional link images and
video posters must use local authenticated attachment content URLs; remote
metadata cannot silently trigger requests from the operator’s browser. Markdown
card previews follow the same rule; remote images appear as explicit links.

CSV previews only fetch local attachment content endpoints. Malformed, oversized,
or unavailable files retain the download action and explain the preview failure.
The existing company-scoped APIs continue to authorize all content access.
Markdown attachments retain the existing server materialization and annotation
workflow. Their body preview appears after that document has been created.

## Examples

PR and commit args use captured facts from public PR #14141. The explanatory
summaries and agent-reported review details are editable examples, not live
provider data. Other stories use illustrative data. Image and video stories use
existing local Paper Trail fixtures. File downloads a small sample text file.
The File story's optional entries demonstrate supplied archive contents; the
app does not inspect arbitrary archive bytes.

## Run and verify

```sh
pnpm storybook
pnpm build-storybook
pnpm --filter @paperclipai/ui typecheck
pnpm check:token-gates
```

Start at `/?path=/story/explorations-artifact-cards-pull-request--pull-request`.
Tests cover metadata validation, bounded CSV parsing/fetching, card selection,
Markdown review/annotations, deep links, agent filtering, and deduplication.
