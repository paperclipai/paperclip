# LLM Wiki Paperclip Asset And Work-Product Security Gate

Status: accepted Phase 5 policy
Date: 2026-05-06
Owner: Security engineering
Scope: Paperclip-derived ingestion into the LLM Wiki before any asset or work-product content indexing ships

## Decision

Phase 5 remains **fail-closed** for Paperclip assets and work products.

- Paperclip-derived **text extraction is allowed only** for issue titles/descriptions, issue comments, and issue documents.
- Paperclip **assets/attachments** and **issue work products** are **metadata-only** in Phase 5.
- **Linked summaries** and **content extraction** for assets/work products are **not approved** in Phase 5.
- No implementation may fetch `/api/assets/:id/content`, dereference a work-product `url`, scrape preview pages, or embed binary/blob content into source bundles or source snapshots.

This keeps the secure path easier than the insecure one and avoids broadening the wiki into a second content-distribution channel.

## Allowed Source Kinds

These source kinds may contribute body text to Paperclip-derived source bundles:

| Source kind | Allowed body fields | Reason |
| --- | --- | --- |
| Issue | `title`, `description`, identifier/status metadata | First-party Paperclip text under company ACL |
| Comment | `body` | First-party Paperclip text under company ACL |
| Document | `body`, `title`, `key`, revision metadata | First-party Paperclip text under company ACL |

## Assets And Work Products

### Assets / attachments

Allowed in Phase 5:

- metadata-only references built from allowlisted structured fields already stored in Paperclip
- recommended fields: `issueId`, `issueCommentId`, `attachmentId`, `assetId`, `originalFilename`, `contentType`, `byteSize`, `sha256`, `createdAt`, `createdByAgentId`, `createdByUserId`

Disallowed in Phase 5:

- fetching asset bytes from `/api/assets/:id/content`
- parsing any blob body, including `text/plain`, `text/markdown`, `application/json`, images, SVG, PDFs, archives, or office formats
- storing `contentPath` in wiki source bundles or source snapshots
- model summarization of attachment bodies

### Work products

Allowed in Phase 5:

- metadata-only references built from allowlisted structured fields already stored in Paperclip
- recommended fields: `issueId`, `workProductId`, `type`, `provider`, `title`, `status`, `reviewState`, `healthStatus`, `externalId`, `isPrimary`, `createdAt`, `updatedAt`
- optional boolean/derived metadata such as `hasUrl: true`

Disallowed in Phase 5:

- fetching or crawling the work-product `url`
- scraping preview pages, artifacts, pull requests, branches, commits, or custom provider targets through the wiki ingestion path
- storing raw `url` values in wiki source bundles or source snapshots
- model-authored linked summaries derived from off-record content

## MIME Allowlists And Size Caps

No MIME allowlist is approved for asset content extraction in Phase 5 because **no asset body extraction is approved at all**.

- Every asset MIME type is treated as opaque for Paperclip-derived indexing.
- Existing upload limits remain storage concerns, not ingestion approvals.
- Work-product destinations are also opaque regardless of MIME type or size.

Any future issue that wants blob parsing must define:

- a positive MIME allowlist
- per-type parser strategy
- per-source size caps
- sandbox/isolation requirements
- prompt-injection handling
- regression tests for refusal paths

## Redaction Rules

Metadata-only means **structured facts only**, not capability-bearing links.

- Do not persist `contentPath` for assets.
- Do not persist raw work-product `url` values.
- Do not persist query strings, fragments, signed URL tokens, or userinfo.
- Prefer stable identifiers (`assetId`, `workProductId`, `externalId`) over links.

This addresses Sensitive Information Disclosure, Unsafe Consumption of APIs, and Insecure Output Handling risks.

## Provenance Rules

Every metadata-only reference must preserve enough provenance to explain where it came from without reading the underlying content:

- `companyId`
- `issueId`
- attachment/work-product id
- producer identity when available
- timestamps
- an explicit `metadata_only` marker in any future reference/snapshot schema

## Review-Required Behavior

Human review is **not** required for plain metadata-only references that stay inside the allowlisted fields above.

Human review **is required**, with a separate security sign-off issue, before enabling any of the following:

- asset body extraction
- work-product URL fetching
- linked summaries generated from asset/work-product content
- storing raw blob links or raw remote URLs in wiki source material
- non-default-space routing for Paperclip-derived asset/work-product references

## Security Rationale

This gate exists because the current host surfaces have different trust properties:

- issue/comment/document text is first-party Paperclip content already exposed through company-scoped issue/document APIs
- asset content is a blob download surface (`/api/assets/:id/content`) and can carry prompt-injection or parser-risk payloads
- work products can point at arbitrary destinations through `url`, which reintroduces SSRF, token leakage, and prompt-injection risk if dereferenced automatically

Relevant threat classes:

- OWASP LLM Top 10: Prompt Injection, Sensitive Information Disclosure, Insecure Output Handling, Excessive Agency
- OWASP API Top 10: SSRF, Unsafe Consumption of APIs, Broken Object Property Level Authorization
- Saltzer & Schroeder: Least Privilege, Fail Securely, Complete Mediation, Secure Defaults

## Follow-Up Implementation Scope

A follow-up implementation issue is justified only for **metadata-only references**.

That implementation must:

- keep assets/work products out of source-bundle body text
- never fetch blob bytes or remote URLs
- redact capability-bearing link fields
- mark references as `metadata_only`
- ship tests proving source bundles/snapshots never contain `contentPath` or raw work-product `url` fields
