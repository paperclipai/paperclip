---
title: Feature Support Case Assessment — Company Artifacts
summary: Support reference for the Company Artifacts feature (shipped v2026.609.0)
version: v2026.609.1 (2026-08-21)
---

# Support Case Assessment: Company Artifacts

## Feature Summary

Company Artifacts is a company-scoped page that indexes every work product, document, comment, and attachment across all issues and runs. It provides a unified view of all agent-produced deliverables, organized by task stack by default, with rich preview support for text, images, and video.

### New in v2026.609.0+

- **Freshness/Staleness Indicators**: Each artifact now carries an `isStale` boolean field (computed on every query). Artifacts not updated in >24 hours are flagged `isStale: true` and receive a faded/desaturated visual treatment on the artifact card. The effect reverses on hover (opacity-90, saturate-50).

- **GET /work-products/:id**: A dedicated endpoint for fetching a single work product by ID. Requires company access and issue read permission. Returns the same work product object used in company artifact listings.

## User-Facing Behavior

### Accessing Artifacts

- Navigate to the Artifacts page from the company sidebar
- The page shows all artifacts across the company, grouped by issue by default
- Each artifact shows: title, type, issue reference, preview, media kind badge, and timestamp

### Grouping Options

| Group By | Behavior |
|----------|----------|
| Issue (default) | Groups artifacts by their parent issue, showing the issue stack |
| Project | Groups artifacts by project |
| None | Flat list of all artifacts |

### Filtering

- **Media kind filter**: all, image, video, text, file
- **Project filter**: narrow to a specific project
- **Search**: full-text search across artifact titles and content previews

### Artifact Types

| Type | Description |
|------|-------------|
| Work product | Files produced by agents during execution |
| Document | Issue documents (plans, specs, etc.) |
| Comment | Issue thread comments |
| Attachment | File attachments on issues |

### Media Kinds

| Kind | Examples |
|------|----------|
| Image | Screenshots, diagrams, photos |
| Video | Screen recordings, demo videos |
| Text | Markdown files, JSON, code, documents |
| File | PDFs, binaries, archives, other |

### Rich Preview

- **Text artifacts**: up to 280-character preview with markdown stripped
- **Image artifacts**: inline thumbnail
- **Video artifacts**: inline playback with thumbnail
- **File artifacts**: icon and filename

## Known Issues & Limitations

### 1. Staleness Threshold Is Hardcoded

The artifact staleness threshold is **24 hours** (`ARTIFACT_STALE_THRESHOLD_HOURS = 24`) and is not configurable at runtime. If a company needs a different threshold per project or artifact type, there is no mechanism to override it today.

### 2. Staleness Is Computed Client-Side Timestamp

The `isStale` boolean is computed on the server at query time based on `updatedAt` vs `Date.now()`. This means:
- A freshly queried artifact may be `isStale: true` shortly after the 24-hour mark
- The value is not persisted — each query re-computes it
- Server clock skew can affect the staleness boundary

### 3. Stale Artifacts Are Still Clickable

Stale visual treatment (opacity-60, saturate-0) is purely cosmetic. The artifact card remains fully interactive — clicks, navigation, and hover actions all work normally. The visual effect restores on hover (opacity-90, saturate-50).

### 4. Preview Text Truncation

Text previews are truncated to **280 characters** after markdown stripping. For long documents, this may not convey enough context. Click through to the full artifact to see the complete content.

### 5. Preview Text Simplification

Markdown formatting is stripped for preview text. This means code blocks, links, images, and formatting are removed. The preview is plain text only.

### 6. Cursor-Based Pagination

Artifacts use cursor-based pagination (not page numbers). The cursor is a base64url-encoded JSON object containing `updatedAt` and `id`. This means:
- You cannot jump to a specific page
- Results are ordered by most recent first
- The cursor must be used as returned by the API

### 7. Attachment Content Requires Authentication

Attachment artifact content URLs (`/api/attachments/{id}/content`) require authentication. Direct links shared outside the platform will not work.

### 8. Storage Service Dependency

Artifact content retrieval depends on the configured storage service (local filesystem or S3-compatible). If the storage service is unavailable, artifact content previews will fail.

## Troubleshooting

### Artifacts page is empty

1. Verify that agents have produced work products, documents, or comments
2. Check that the company has active issues with completed runs
3. Verify the filter is not too restrictive (try clearing kind, project, and search filters)

### Stale artifacts are not showing the faded treatment

1. The staleness threshold is 24 hours — artifacts updated within that window are considered fresh
2. Verify the artifact's `updatedAt` timestamp is older than 24 hours
3. Check that the `isStale` field is present in the API response (server restart may be needed after deploy)
4. The visual treatment requires the updated ArtifactCard component — verify the UI was rebuilt after deployment

### Artifacts show stale unexpectedly

1. The staleness check uses server-side `Date.now()` — if the server clock is skewed, staleness boundaries may shift
2. Staleness is re-computed on every query, not stored — the same artifact may flip from fresh to stale between queries as time passes
3. Check `updatedAt` on the artifact — if an agent hasn't updated it recently, stale is correct

### GET /work-products/:id returns 404

1. Verify the work product ID is correct (UUID format)
2. Confirm the work product belongs to an issue the user has read access to
3. Check that the work product was not deleted

### Artifact preview is not loading

1. Check if the storage service is available
2. For text artifacts, the preview is generated from the first 4096 bytes
3. For attachment artifacts, the user must be authenticated
4. Check browser console for network errors

### Video artifacts don't play

1. Video playback depends on browser codec support
2. Very large video files may take time to load
3. Check that the video content type is correctly set

### Search returns no results

1. Search matches against artifact title and text preview content
2. File names and binary content are not searchable
3. Try a broader search term

## Support Escalation Path

| Issue | Escalate To |
|-------|-------------|
| Storage service unavailable | CTO — check S3/filesystem configuration |
| Artifact content shows wrong preview | CTO — preview generation issue |
| Video artifacts don't render | CTO — browser compatibility or codec issue |
| Pagination is broken | CTO — cursor encoding/decoding issue |
| Permissions: user can't see artifacts | CTO — authz scope issue |
| Staleness threshold needs adjusting | CTO — hardcoded constant in `packages/shared/src/validators/artifact.ts` |
| Stale visual treatment not rendering | CTO — ArtifactCard component or CSS issue |
| GET /work-products/:id auth failure | CTO — issue read gate or company access assertion |

## Related Code Locations

- `server/src/services/company-artifacts.ts` — main artifacts service (includes `isStale()` computation)
- `server/src/routes/companies.ts` — artifacts API routes
- `server/src/routes/issues.ts` — `GET /work-products/:id` route
- `ui/src/components/artifacts/ArtifactCard.tsx` — stale visual treatment via `isStale` prop
- `packages/shared/src/validators/artifact.ts` — `ARTIFACT_STALE_THRESHOLD_HOURS` constant + `isStale` schema
- `packages/shared/src/types/artifact.ts` — `isStale?: boolean` on `CompanyArtifact` interface
- `server/src/__tests__/company-artifacts-service.test.ts` — test coverage