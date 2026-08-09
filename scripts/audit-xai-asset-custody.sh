#!/usr/bin/env bash
# Data-only inventory for historical xAI media references.
#
# This intentionally creates one evidence file, not a fleet of recovery tasks.
# A historic provider URL is not a durable-asset identity, so the report marks
# issue records that need a human retention/recovery decision without claiming
# that each URL is a distinct missing file.
set -euo pipefail

DB_HOST="${PAPERCLIP_AUDIT_DB_HOST:-127.0.0.1}"
DB_PORT="${PAPERCLIP_AUDIT_DB_PORT:-54329}"
DB_USER="${PAPERCLIP_AUDIT_DB_USER:-paperclip}"
DB_NAME="${PAPERCLIP_AUDIT_DB_NAME:-paperclip}"
REPORT_DIR="${PAPERCLIP_XAI_CUSTODY_REPORT_DIR:-$HOME/.paperclip/reports}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="${1:-$REPORT_DIR/xai-asset-custody-$STAMP.json}"

command -v psql >/dev/null 2>&1 || {
  echo "psql is required for the xAI custody audit" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "node is required for the xAI custody audit" >&2
  exit 1
}

mkdir -p "$(dirname "$OUTPUT")"
ROWS="$(mktemp -t paperclip-xai-custody.XXXXXX)"
trap 'rm -f "$ROWS"' EXIT

# Do not emit raw temporary/public URLs into the report. They may be expired,
# sensitive, and are not reliable asset identities. The evidence is the issue
# record plus source counts and durable Paperclip attachment coverage.
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -AtF $'\t' > "$ROWS" <<'SQL'
WITH comment_refs AS (
  SELECT company_id, issue_id, count(*)::int AS count, max(updated_at) AS last_seen_at
  FROM issue_comments
  WHERE deleted_at IS NULL
    AND body ~* 'https?://[^[:space:]<>()"'']*x\.ai'
  GROUP BY company_id, issue_id
), document_refs AS (
  SELECT idoc.issue_id, doc.company_id, count(*)::int AS count, max(doc.updated_at) AS last_seen_at
  FROM issue_documents idoc
  JOIN documents doc ON doc.id = idoc.document_id
  WHERE doc.latest_body ~* 'https?://[^[:space:]<>()"'']*x\.ai'
  GROUP BY idoc.issue_id, doc.company_id
), refs AS (
  SELECT
    COALESCE(c.company_id, d.company_id) AS company_id,
    COALESCE(c.issue_id, d.issue_id) AS issue_id,
    COALESCE(c.count, 0) AS comment_refs,
    COALESCE(d.count, 0) AS document_refs,
    GREATEST(COALESCE(c.last_seen_at, '-infinity'::timestamptz), COALESCE(d.last_seen_at, '-infinity'::timestamptz)) AS last_seen_at
  FROM comment_refs c
  FULL OUTER JOIN document_refs d ON d.issue_id = c.issue_id
), attachment_counts AS (
  SELECT
    ia.issue_id,
    count(*)::int AS attachment_count,
    count(*) FILTER (WHERE a.content_type LIKE 'video/%')::int AS video_attachment_count
  FROM issue_attachments ia
  JOIN assets a ON a.id = ia.asset_id
  GROUP BY ia.issue_id
)
SELECT
  r.company_id,
  r.issue_id,
  i.identifier,
  i.title,
  r.comment_refs,
  r.document_refs,
  COALESCE(ac.attachment_count, 0),
  COALESCE(ac.video_attachment_count, 0),
  r.last_seen_at
FROM refs r
JOIN issues i ON i.id = r.issue_id
LEFT JOIN attachment_counts ac ON ac.issue_id = r.issue_id
ORDER BY COALESCE(ac.attachment_count, 0) ASC, r.last_seen_at DESC, i.identifier;
SQL

node - "$ROWS" "$OUTPUT" <<'NODE'
const fs = require("fs");
const [rowsPath, outputPath] = process.argv.slice(2);
const rows = fs.readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => {
  const [companyId, issueId, identifier, title, commentRefs, documentRefs, attachmentCount, videoAttachmentCount, lastSeenAt] = line.split("\t");
  return {
    companyId,
    issueId,
    identifier,
    title,
    commentRefs: Number(commentRefs),
    documentRefs: Number(documentRefs),
    attachmentCount: Number(attachmentCount),
    videoAttachmentCount: Number(videoAttachmentCount),
    lastSeenAt,
    disposition: Number(attachmentCount) > 0 ? "durable_attachment_present" : "needs_consolidated_review",
  };
});
const review = rows.filter((row) => row.disposition === "needs_consolidated_review");
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: "Paperclip issue comments and issue-linked documents containing x.ai URLs",
  importantLimit: "URL references are not asset identities. Do not create one recovery task per URL; use this one report to decide retention or targeted recovery.",
  summary: {
    issuesWithXaiReferences: rows.length,
    issuesWithAnyAttachment: rows.length - review.length,
    issuesNeedingConsolidatedReview: review.length,
    totalCommentReferenceRecords: rows.reduce((sum, row) => sum + row.commentRefs, 0),
    totalDocumentReferenceRecords: rows.reduce((sum, row) => sum + row.documentRefs, 0),
  },
  issues: rows,
};
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputPath, summary: report.summary }, null, 2));
NODE
