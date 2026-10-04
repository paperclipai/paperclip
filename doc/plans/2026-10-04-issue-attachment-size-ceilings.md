# Two attachment size ceilings: heap-buffered and disk-spooled

Status: proposed (implemented in the same change)
Date: 2026-10-04

## Context

Every attachment upload path in the server funnels through
`MAX_ATTACHMENT_BYTES` (`server/src/attachment-types.ts`), default 10 MB. That
number is correct for the paths it was written for — company logo, case
attachments, company import — which are all small and all buffered in memory by
`multer.memoryStorage()`. The whole request body sits on the Node heap for the
lifetime of the request, so 10 MB is simultaneously a product limit and a
memory-exhaustion guard.

`POST /companies/:companyId/issues/:issueId/attachments` was on that same cap,
and that is wrong for its actual content. A rendered media deliverable — a
12-15 minute 1080p H.264 episode — is 30-70 MB. At 10 MB those deliverables are
structurally unattachable: an agent finishing an episode has no way to hand the
artifact to the board, so it falls back to a local filesystem path that the
board cannot open. That is a product failure, not a tuning knob.

The naive fix — raise the one global cap to 512 MB — is worse than the bug. It
would mean a single in-memory path could be pushed to 512 MB, and four concurrent
uploads would pin 2 GB of heap on the process that also runs every agent adapter.

## Decision

Split the ceiling by the property that actually differs between the paths: does
the request body need to be resident in memory?

- `MAX_ATTACHMENT_BYTES` (unchanged, `PAPERCLIP_ATTACHMENT_MAX_BYTES`, 10 MB) —
  every heap-buffered path. Unchanged deliberately: it is still a memory guard.
- `MAX_ISSUE_ATTACHMENT_BYTES` (`PAPERCLIP_ISSUE_ATTACHMENT_MAX_BYTES`, 512 MB) —
  the issue attachment path only, which spools to disk. The cost of a large
  upload here is transient disk equal to the file size, not resident heap.

The issue attachment route therefore uses `multer.diskStorage` into a
per-request spool directory under the instance data dir
(`server/src/services/issue-attachment-uploads.ts`), and streams the spool file
into the storage provider. Peak memory on that path is one stream chunk.

Two invariants keep the spool from becoming a disk leak:

- The spool directory is released on **every** exit path, including the
  `LIMIT_FILE_SIZE` rejection where multer never sets `req.file`. The spooler
  tracks the directory it created in a `WeakMap` keyed on the request for
  exactly this case.
- Orphan spool directories from a hard crash are swept after 24h
  (`startAttachmentUploadSpoolSweeper`, wired into server startup/shutdown).

`PutFileInput` requires an exact `byteSize` and `sha256` up front for a streamed
body, so the digest comes from a second disk read of the spool file
(`hashSpooledAttachmentFile`). That is a second pass over disk, not over the
heap, and it keeps the storage contract that already rejects a truncated stream
before recording an attachment row.

## Consequences

- 30-70 MB media deliverables become attachable to issues, and the board can open
  them from the thread.
- Operator blast radius is unchanged for every other upload path: a deployment
  that sets `PAPERCLIP_ATTACHMENT_MAX_BYTES=1MB` still gets 1 MB on the logo and
  case paths. The issue cap is a separate variable with its own 512 MB default, so
  it can be tightened independently.
- The issue route now writes to the instance data dir. An operator running with a
  read-only data dir, or with `diskStorage` unavailable, sees upload failures
  rather than silent truncation.
- Disk, not memory, is the new failure surface: concurrent large uploads consume
  transient disk proportional to file size. The spool sweep bounds the tail after
  a crash, but not the peak during normal operation.

## Alternatives considered

- **Raise the single global cap.** Rejected: it would let any heap-buffered path
  be pushed to 512 MB, trading a product bug for a memory-exhaustion bug with a
  much larger blast radius.
- **Enforce the cap at the proxy/ingress layer only.** Rejected: it makes the
  limit invisible to the API contract, so the error a caller gets is a proxy
  error rather than a 422 that names the ceiling.
- **Client-side chunked/resumable uploads.** Rejected as over-engineering for
  this size range. It would be the right answer at multi-GB, and it would let the
  10 MB heap path stay universal. Not worth the protocol surface now.
- **Keep the cap and require agents to upload externally.** Rejected: it is the
  status quo that produced this, and it hands the board a link it cannot verify.

## Test plan

- `server/src/__tests__/issue-attachment-uploads.test.ts` — spool lifecycle:
  per-request isolation, release, and the 24h orphan sweep.
- `server/src/__tests__/issue-attachment-routes.test.ts` — a 70 MB video attaches
  in one call, storage receives a stream rather than a buffer, the stored object's
  size and SHA-256 match, and no spool survives the success, empty-file,
  missing-file, or over-cap paths.
- Rollback: revert this change. Nothing in it is a schema or migration change, so
  there is no data to unwind; the only residue is spool directories, which the
  sweep clears within 24h.