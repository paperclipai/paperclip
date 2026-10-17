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

Three invariants keep the spool from becoming a disk leak:

- **Aggregate budget.** `MAX_ISSUE_ATTACHMENT_BYTES` bounds one request, not N
  of them, so the spooler also reserves an instance-wide byte budget
  (`PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES`) *before* multer writes the
  first byte. An upload that would exceed the budget is refused with 429 and
  `Retry-After` instead of consuming disk. The default is one full-size upload,
  the most conservative value that still admits a single large deliverable;
  operators with disk to spare raise it. The reservation keys off the declared
  `Content-Length` of the multipart body, falling back to the full per-request
  ceiling for a chunked request, and it is released with the spool plus a
  response-`close` backstop so an aborted handler cannot leak it.
- **Release on every exit path**, including the `LIMIT_FILE_SIZE` rejection where
  multer never sets `req.file`. The spooler tracks the directory it created in a
  `WeakMap` keyed on the request for exactly this case.
- **Explicit liveness for the sweep.** Orphan spool directories from a hard
  crash, and any left behind by a failed `fs.rm`, are swept after 1h
  (`startAttachmentUploadSpoolSweeper`, wired into server
  startup/shutdown). Liveness is decided by an in-process registry of active
  spool directories, not by the directory's mtime: an mtime does not advance
  while the file inside it is written or read, so an mtime rule would reap a
  slow upload underneath an active request. A failed cleanup is logged at warn
  and then retried by the sweep rather than silently swallowed.

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
- Disk, not memory, is the new failure surface. The aggregate budget caps peak
  spool usage at `PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES` rather than at
  N x file size, so the peak is bounded by configuration instead of by how many
  large uploads happen to overlap. The cost is a new failure mode: a caller can
  now be refused with 429 while capacity is busy. That is deliberate — the
  alternative is an instance that runs out of disk.
- The spool sweep threshold drops from 24h to 1h because liveness is tracked
  explicitly, so the shorter age no longer risks reaping a live upload. A failed
  cleanup is retried within an hour instead of a day.
- The budget is process-scoped. A multi-process deployment behind a load
  balancer gets one budget per process, so the effective instance-wide ceiling
  scales with process count. A shared quota store would be the fix if that ever
  matters; it is not worth the dependency at the current scale.

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
  per-request isolation, release, and the orphan sweep; aggregate budget
  reserve/refuse/release including the response-`close` backstop and the
  ceiling fallback for a request with no declared length; sweep liveness,
  asserting an in-flight directory is never reaped however old it looks and
  that a leftover is reclaimed.
- `server/src/__tests__/issue-attachment-routes.test.ts` — a 70 MB video attaches
  in one call, storage receives a stream rather than a buffer, the stored object's
  size and SHA-256 match, no spool survives the success, empty-file,
  missing-file, or over-cap paths, and an upload over the aggregate budget is
  refused with 429 before any byte reaches storage or disk.
- Rollback: revert this change. Nothing in it is a schema or migration change, so
  there is no data to unwind; the only residue is spool directories, which the
  sweep clears within 1h.