# Storage System Implementation Plan (V1)

Status: Draft  
Owner: Backend + UI  
Date: 2026-02-20

## Goal

Add a single storage subsystem for Paperclip that supports:

- local disk storage for single-user local deployment
- S3-compatible object storage for cloud deployment
- a provider-agnostic interface for issue images and future file attachments

## V1 Scope

- First consumer: issue attachments/images.
- Storage adapters: `local_disk` and `s3`.
- Files are always company-scoped and access-controlled.
- API serves attachment bytes through authenticated Paperclip endpoints.

## Out of Scope (This Draft)

- Public unauthenticated object URLs.
- CDN/signed URL optimization.
- Image transformations/thumbnails.
- Malware scanning pipeline.

## Key Decisions

- Default local path is under instance root: `~/.paperclip/instances/<instanceId>/data/storage`.
- Object bytes live in storage provider; metadata lives in Postgres.
- `assets` is generic metadata table; `issue_attachments` links assets to issues/comments.
- S3 credentials come from runtime environment/default AWS provider chain, not DB rows.
- All object keys include company prefix to preserve hard tenancy boundaries.

## Phase 1: Shared Config + Provider Contract

### Checklist (Per File)

- [ ] `packages/shared/src/constants.ts`: add `STORAGE_PROVIDERS` and `StorageProvider` type.
- [ ] `packages/shared/src/config-schema.ts`: add `storageConfigSchema` with:
  - provider: `local_disk | s3`
  - localDisk.baseDir
  - s3.bucket, s3.region, s3.endpoint?, s3.prefix?, s3.forcePathStyle?
- [ ] `packages/shared/src/index.ts`: export new storage config/types.
- [ ] `cli/src/config/schema.ts`: ensure re-export includes new storage schema/types.
- [ ] `cli/src/commands/configure.ts`: add `storage` section support.
- [ ] `cli/src/commands/onboard.ts`: initialize default storage config.
- [ ] `cli/src/prompts/storage.ts`: new prompt flow for local disk vs s3 settings.
- [ ] `cli/src/prompts/index` (if present) or direct imports: wire new storage prompt.
- [ ] `server/src/config.ts`: load storage config and resolve home-aware local path.
- [ ] `server/src/home-paths.ts`: add `resolveDefaultStorageDir()`.
- [ ] `doc/CLI.md`: document `configure --section storage`.
- [ ] `doc/DEVELOPING.md`: document default local storage path and overrides.

### Acceptance Criteria

- `paperclipai onboard` writes a valid `storage` config block by default.
- `paperclipai configure --section storage` can switch between local and s3 modes.
- Server startup reads storage config without env-only hacks.

## Phase 2: Server Storage Subsystem + Providers

### Checklist (Per File)

- [ ] `server/src/storage/types.ts`: define provider + service interfaces.
- [ ] `server/src/storage/service.ts`: provider-agnostic service (key generation, validation, stream APIs).
- [ ] `server/src/storage/local-disk-provider.ts`: implement local disk provider with safe path resolution.
- [ ] `server/src/storage/s3-provider.ts`: implement S3-compatible provider (`@aws-sdk/client-s3`).
- [ ] `server/src/storage/provider-registry.ts`: provider lookup by configured id.
- [ ] `server/src/storage/index.ts`: export storage factory helpers.
- [ ] `server/src/services/index.ts`: export `storageService` factory.
- [ ] `server/src/app.ts` or route wiring point: inject/use storage service where needed.
- [ ] `server/package.json`: add AWS SDK dependency if not present.

### Acceptance Criteria

- In `local_disk` mode, uploading + reading a file round-trips bytes on disk.
- In `s3` mode, service can `put/get/delete` against S3-compatible endpoint.
- Invalid provider config yields clear startup/config errors.

## Phase 3: Database Metadata Model

### Checklist (Per File)

- [ ] `packages/db/src/schema/assets.ts`: new generic asset metadata table.
- [ ] `packages/db/src/schema/issue_attachments.ts`: issue-to-asset linking table.
- [ ] `packages/db/src/schema/index.ts`: export new tables.
- [ ] `packages/db/src/migrations/*`: generate migration for both tables and indexes.
- [ ] `packages/shared/src/types/issue.ts` (or new asset types file): add `IssueAttachment` type.
- [ ] `packages/shared/src/index.ts`: export new types.

### Suggested Columns

- `assets`:
  - `id`, `company_id`, `provider`, `object_key`
  - `content_type`, `byte_size`, `sha256`, `original_filename`
  - `created_by_agent_id`, `created_by_user_id`, timestamps
- `issue_attachments`:
  - `id`, `company_id`, `issue_id`, `asset_id`, `issue_comment_id` (nullable), timestamps

### Acceptance Criteria

- Migration applies cleanly on empty and existing local dev DB.
- Metadata rows are company-scoped and indexed for issue lookup.

## Phase 4: Issue Attachment API

### Checklist (Per File)

- [ ] `packages/shared/src/validators/issue.ts`: add schemas for upload/list/delete attachment operations.
- [ ] `server/src/services/issues.ts`: add attachment CRUD helpers with company checks.
- [ ] `server/src/routes/issues.ts`: add endpoints:
  - `POST /companies/:companyId/issues/:issueId/attachments` (multipart)
  - `GET /issues/:issueId/attachments`
  - `GET /attachments/:attachmentId/content`
  - `DELETE /attachments/:attachmentId`
- [ ] `server/src/routes/authz.ts`: reuse/enforce company access for attachment endpoints.
- [ ] `server/src/services/activity-log.ts` usage callsites: log attachment add/remove mutations.
- [ ] `server/src/app.ts`: ensure multipart parsing middleware is in place for upload route.

### API Behavior

- Enforce max size and image/content-type allowlist in V1.
- Return consistent errors: `400/401/403/404/409/422/500`.
- Stream bytes instead of buffering large payloads in memory.

### Acceptance Criteria

- Board and same-company agents can upload and read attachments per issue permissions.
- Cross-company access is denied even with valid attachment id.
- Activity log records attachment add/remove actions.

## Phase 5: UI Issue Attachment Integration

### Checklist (Per File)

- [ ] `ui/src/api/issues.ts`: add attachment API client methods.
- [ ] `ui/src/api/client.ts`: support multipart upload helper (no JSON `Content-Type` for `FormData`).
- [ ] `ui/src/lib/queryKeys.ts`: add issue attachment query keys.
- [ ] `ui/src/pages/IssueDetail.tsx`: add upload UI + attachment list/query invalidation.
- [ ] `ui/src/components/CommentThread.tsx`: optional comment image attach or display linked images.
- [ ] `packages/shared/src/types/index.ts`: ensure attachment types are consumed cleanly in UI.

### Acceptance Criteria

- User can upload an image from issue detail and see it listed immediately.
- Uploaded image can be opened/rendered via authenticated API route.
- Upload and fetch failures are visible to users (no silent errors).

## Phase 6: CLI Doctor + Operational Hardening

### Checklist (Per File)

- [ ] `cli/src/checks/storage-check.ts`: add storage check (local writable dir, optional S3 reachability check).
- [ ] `cli/src/checks/index.ts`: export new storage check.
- [ ] `cli/src/commands/doctor.ts`: include storage check in doctor sequence.
- [ ] `doc/DATABASE.md` or `doc/DEVELOPING.md`: mention storage backend behavior by deployment mode.
- [ ] `doc/SPEC-implementation.md`: add storage subsystem and issue-attachment endpoint contract.

### Acceptance Criteria

- `paperclipai doctor` reports actionable storage status.
- Local single-user install works without extra cloud credentials.
- Cloud config supports S3-compatible endpoint without code changes.

## Test Plan

### Server Integration Tests

- [ ] `server/src/__tests__/issue-attachments.auth.test.ts`: company boundary and permission tests.
- [ ] `server/src/__tests__/issue-attachments.lifecycle.test.ts`: upload/list/read/delete flow.
- [ ] `server/src/__tests__/storage-local-provider.test.ts`: local provider path safety and round-trip.
- [ ] `server/src/__tests__/storage-s3-provider.test.ts`: s3 provider contract (mocked client).
- [ ] `server/src/__tests__/activity-log.attachments.test.ts`: mutation logging assertions.

### CLI Tests

- [ ] `cli/src/__tests__/configure-storage.test.ts`: configure section writes valid config.
- [ ] `cli/src/__tests__/doctor-storage-check.test.ts`: storage health output and repair behavior.

### UI Tests (if present in current stack)

- [ ] `ui/src/...`: issue detail upload and error handling tests.

## Verification Gate Before Merge

Run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If any command is skipped, document exactly what was skipped and why.

## Implementation Order

1. Phase 1 and Phase 2 (foundation, no user-visible breakage)
2. Phase 3 (DB contract)
3. Phase 4 (API)
4. Phase 5 (UI consumer)
5. Phase 6 (doctor/docs hardening)

