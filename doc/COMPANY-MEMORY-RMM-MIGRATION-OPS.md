# rh-memory-mcp migration operations appendix

**Status (16 Nov 2026):** the importer (rh-data-platform PR 12155), the filter
(fork PR 402), capture-off for Claude/Codex (PR 401), and the `responsibleUserId`
enrolment override (PR 414, merge `773eed4a`; say "once deployed" until it is) are all
merged. The pipeline ran in production on 2026-11-13..16; see the
[migration runbook](./COMPANY-MEMORY-RMM-MIGRATION.md) for the steps. No pin, deploy,
or production operation is performed by this appendix.

Production guard values used: schema `rh_memory_mcp_prod`, collection `memories`,
role `rh_memory_app_prod`, model `text-embedding-3-small`, dims `1536`. The host
fingerprint (`sha256:<12 hex>`) hashes host:port only and dev and prod share one
Postgres, so schema + collection + role are the real guards. The importer's own README
shows the non-prod values (`rh_memory_mcp`, `rh_memory_app`).

## Guards and exact command source

The exact flags were checked in `cli.py`'s `build_parser` and `target_guards`:
`--expect-schema`, `--expect-collection`, `--expect-db-role`,
`--expect-embed-model`, `--expect-embed-dims`, and production's
`--expect-host-fingerprint`. In an approved operator shell, set only protected
paths/configuration (never secrets in this document):

```bash
GUARDS=(--expect-schema "$SCHEMA" --expect-collection "$COLLECTION" \
  --expect-db-role "$DB_ROLE" --expect-embed-model "$EMBED_MODEL" \
  --expect-embed-dims "$EMBED_DIMS")
COMMON=(--manifest "$MANIFEST" --jsonl "$JSONL" --agent "$AGENT" \
  --output-dir "$OUT")
uv run python -m scripts.import_memories "${COMMON[@]}" "${GUARDS[@]}"
# dry-run: resolved target is logged; expectation guards are not checked.
RH_MEMORY_IMPORT_ALLOWED=true uv run python -m scripts.import_memories \
  "${COMMON[@]}" "${GUARDS[@]}" --expect-host-fingerprint "$HOST_FINGERPRINT" --apply
uv run python -m scripts.import_memories "${COMMON[@]}" --verify
uv run python -m scripts.import_memories "${COMMON[@]}" "${GUARDS[@]}" \
  --expect-host-fingerprint "$HOST_FINGERPRINT" --rollback \
  --migration-id "$MIGRATION_ID" --apply
```

The apply guard checks are the authoritative gate; `--verify` without
`--apply` does not check them. Rollback may add `--ids-file "$IDS_FILE"`.
Resolve every placeholder from approved target configuration. A dry-run host
fingerprint comparison is separate and must use pinned trusted configuration,
not blind copy/paste.

The importer must verify manifest digest, metadata/text counts, ownership, and
errors before apply. Record all results. A zero exit code is not recall proof:
an own-ID probe that misses is WARN ONLY. Operators must inspect and record
hits, then run a fresh-session behavioral recall and isolation check before
claiming recall.

## Transfer gate

Do not document or rely on a piped-stdin `aws ecs execute-command` example; that
method is not rehearsed. Run the importer on an approved
operator host with restricted target access and locally protected,
sha-256-verified files. Alternatively use a separately rehearsed and approved
transport, then verify byte count and sha-256 at the destination **before**
apply. If no proven transport exists, status is **BLOCKED**. Do not fabricate
S3, credential, upload, or test-production commands.

## Capture and rollback

The import is additive per agent. The old tenant is retained; there is no
publish/flip/drain/prune. This document alone authorizes no production sweep, import,
or enrolment.

Imported rollback (`--rollback --agent <id> --migration-id <uuid> --apply`, with the
guards and `RH_MEMORY_IMPORT_ALLOWED=true`) removes only rows identified by provenance
(`source`, `migration_id`, agent, and import key). Ordinary post-cutover memory remains.
It does not switch the backend or alter captures. Keep each agent's import journal
(0600) until sign-off. Backend restoration is a separate approved change and requires a
complete prior configuration/environment snapshot, secret reference and version
identifiers, and a credential revocation/rotation plan owned by the service owner. Do
not put raw secrets in this runbook. There is no automatic unenrolment or rollback
endpoint.

Claude/Codex enrolment defaults to capture-off (`RH_MEMORY_CAPTURE=off`, PR 401) unless
the server sets `PAPERCLIP_AGENT_MEMORY_CAPTURE=on`; an explicit agent
`RH_MEMORY_CAPTURE` is preserved. Recall-only agents have no manual-save tool. The
Hermes `mem0-auto-sync-off` flag makes the adapter set `MEM0_AUTO_SYNC=false` to disable
end-of-turn auto-sync after the patched image; explicit Mem0 tools remain available.
Preserve existing env keys. Enrolment does not enable capture universally.

## Importer operating notes

- Apply takes a per-agent Postgres advisory lock honoured only by this tool.
- Importing two upgrades of one agent duplicates rows (`import_key` is new per upgrade).
- Direct writes bypass the REST rate limiter; each record costs an OpenAI embedding call and a DB session.
- `--sleep-interval` (default 0.05 s), `--verify-probes` (default 5) and `--output-dir` (journal directory) are importer flags.
