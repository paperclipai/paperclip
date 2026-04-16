# AWS File Store — Command Reference

## Environment & Aliases

```bash
B="$FILE_STORE_BUCKET"
P="${FILE_STORE_PREFIX:-file-store}"
O="${FILE_STORE_ORG:-$PAPERCLIP_COMPANY_ID}"
FILES="s3://$B/$P/files/$O"
IDX="s3://$B/$P/idx/$O"
```

AWS CLI v2 reads these env vars automatically — no extra flags needed:
- `AWS_ENDPOINT_URL` — MinIO or other S3-compatible endpoint
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — credentials
- `AWS_DEFAULT_REGION` — region (default: `us-east-1`)

---

## Index Design

The index lives at `s3://$B/$P/idx/$O/` as zero-byte "marker" objects:

```
idx/$ORG/
├── tag/<tag>/<file-path>           # e.g. idx/acme/tag/report/kb/markdown/report.md
├── date/<YYYY-MM-DD>/<file-path>   # e.g. idx/acme/date/2026-04-09/kb/markdown/report.md
└── author/<agent-id>/<file-path>   # e.g. idx/acme/author/agent-abc/kb/markdown/report.md
```

**Why 0-byte objects:**
- `PutObject` is atomic in S3 — no partial writes
- Two agents writing different index entries never conflict
- S3 ListObjects prefix scans are server-side — no client-side filtering

**Creating a marker:**
```bash
echo -n | aws s3 cp - "s3://..."
# or equivalently:
printf '' | aws s3 cp - "s3://..."
```

---

## Metadata Keys

All lowercase. AWS normalizes metadata keys to lowercase.

| Key | Value | Example |
|-----|-------|---------|
| `createdby` | Agent ID | `agent-abc123` |
| `createdat` | ISO 8601 UTC | `2026-04-09T14:30:00Z` |
| `updatedby` | Agent ID | `agent-abc123` |
| `updatedat` | ISO 8601 UTC | `2026-04-09T15:00:00Z` |
| `tags` | Comma-separated, no spaces | `report,finance,q4` |
| `description` | Short description | `Q4 financial report` |
| `encoding` | Only set for binary | `base64` |

**Limit:** 2 KB total across all metadata keys. Use short descriptions.

---

## Full Operation Reference

### Write (new file)

```bash
aws s3 cp <local-path> "$FILES/<path>" \
  --metadata "createdby=$PAPERCLIP_AGENT_ID,createdat=$(date -u +%Y-%m-%dT%H:%M:%SZ),tags=<tags>,description=<desc>"

for tag in $(echo "<tags>" | tr ',' ' '); do
  echo -n | aws s3 cp - "$IDX/tag/$tag/<path>"
done
echo -n | aws s3 cp - "$IDX/date/$(date +%Y-%m-%d)/<path>"
echo -n | aws s3 cp - "$IDX/author/$PAPERCLIP_AGENT_ID/<path>"
```

### Overwrite (existing file, update metadata)

```bash
# --metadata-directive REPLACE overwrites all metadata
aws s3 cp <local-path> "$FILES/<path>" \
  --metadata-directive REPLACE \
  --metadata "createdby=<orig>,createdat=<orig>,updatedby=$PAPERCLIP_AGENT_ID,updatedat=$(date -u +%Y-%m-%dT%H:%M:%SZ),tags=<new-tags>,description=<new-desc>"

# Update tag index: remove old tags, add new tags
OLD_TAGS=<previous-tags>
NEW_TAGS=<new-tags>
for tag in $(echo "$OLD_TAGS" | tr ',' ' '); do
  aws s3 rm "$IDX/tag/$tag/<path>" 2>/dev/null
done
for tag in $(echo "$NEW_TAGS" | tr ',' ' '); do
  echo -n | aws s3 cp - "$IDX/tag/$tag/<path>"
done
```

### Read text

```bash
aws s3 cp "$FILES/<path>" -
```

### Read binary (base64-encoded)

```bash
aws s3 cp "$FILES/<path>" - | base64 --decode > /tmp/output
```

### List directory (non-recursive)

```bash
aws s3 ls "$FILES/<dir>/"
# Output: date time size key
```

### List directory (recursive, paths only)

```bash
aws s3 ls "$FILES/<dir>/" --recursive | awk '{print $4}' | sed "s|$P/files/$O/||"
```

### Tree view

```bash
aws s3 ls "$FILES/" --recursive | awk '{print $4}' \
  | sed "s|$P/files/$O/||" | sort \
  | awk -F'/' '{
      depth = NF - 1
      indent = ""
      for (i = 0; i < depth; i++) indent = indent "  "
      print indent "└─ " $NF
    }'
```

### Stat

```bash
aws s3api head-object --bucket "$B" --key "$P/files/$O/<path>"
```

Returns JSON with `ContentLength`, `LastModified`, `ContentType`, `Metadata`.

### Check existence

```bash
aws s3api head-object --bucket "$B" --key "$P/files/$O/<path>" 2>&1 \
  | grep -q "404" && echo "NOT FOUND" || echo "EXISTS"
```

### Search by tag

```bash
aws s3 ls "$IDX/tag/<tag>/" --recursive \
  | awk '{print $4}' | sed "s|$P/idx/$O/tag/<tag>/||"
```

### Search by name pattern

```bash
aws s3 ls "$FILES/" --recursive | awk '{print $4}' \
  | sed "s|$P/files/$O/||" | grep "<pattern>"
# grep supports regex; for glob use: grep -E "<glob-converted-to-regex>"
```

### Search by multiple tags (AND)

```bash
# Intersect two sorted lists with comm -12
comm -12 \
  <(aws s3 ls "$IDX/tag/<tag1>/" --recursive | awk '{print $4}' | sed "s|.*/tag/<tag1>/||" | sort) \
  <(aws s3 ls "$IDX/tag/<tag2>/" --recursive | awk '{print $4}' | sed "s|.*/tag/<tag2>/||" | sort)
```

### Search by date range

```bash
aws s3 ls "$IDX/date/" --recursive | awk '{print $4}' \
  | awk -F'/' -v lo="2026-04-01" -v hi="2026-04-09" '$5 >= lo && $5 <= hi {print $0}' \
  | sed "s|$P/idx/$O/date/[^/]*/||"
```

### Search by author

```bash
aws s3 ls "$IDX/author/<agent-id>/" --recursive \
  | awk '{print $4}' | sed "s|$P/idx/$O/author/<agent-id>/||"
```

### Move / Rename

```bash
SRC="<source-path>"
DST="<destination-path>"

# Read current metadata
TAGS=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$SRC" \
  --query 'Metadata.tags' --output text)
ORIG_AUTHOR=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$SRC" \
  --query 'Metadata.createdby' --output text)
ORIG_DATE=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$SRC" \
  --query 'Metadata.createdat' --output text)

# Copy file
aws s3 cp "$FILES/$SRC" "$FILES/$DST" --metadata-directive COPY

# Create new index entries
for tag in $(echo "$TAGS" | tr ',' ' '); do
  echo -n | aws s3 cp - "$IDX/tag/$tag/$DST"
done
echo -n | aws s3 cp - "$IDX/date/$(date +%Y-%m-%d)/$DST"
echo -n | aws s3 cp - "$IDX/author/$PAPERCLIP_AGENT_ID/$DST"

# Remove old index entries (all dimensions)
for tag in $(echo "$TAGS" | tr ',' ' '); do
  aws s3 rm "$IDX/tag/$tag/$SRC" 2>/dev/null
done
aws s3 ls "$IDX/" --recursive | awk '{print $4}' | grep "/$SRC$" \
  | xargs -I{} aws s3 rm "s3://$B/{}" 2>/dev/null

# Remove old file
aws s3 rm "$FILES/$SRC"
```

### Remove file

```bash
FILE="<path>"
TAGS=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$FILE" \
  --query 'Metadata.tags' --output text 2>/dev/null)

for tag in $(echo "$TAGS" | tr ',' ' '); do
  aws s3 rm "$IDX/tag/$tag/$FILE" 2>/dev/null
done
aws s3 ls "$IDX/" --recursive | awk '{print $4}' | grep "/$FILE$" \
  | xargs -I{} aws s3 rm "s3://$B/{}" 2>/dev/null

aws s3 rm "$FILES/$FILE"
```

### Remove directory recursively

```bash
DIR="<dir-path>/"
aws s3 ls "$FILES/$DIR" --recursive | awk '{print $4}' \
  | sed "s|$P/files/$O/||" \
  | while read path; do
      TAGS=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$path" \
        --query 'Metadata.tags' --output text 2>/dev/null)
      for tag in $(echo "$TAGS" | tr ',' ' '); do
        aws s3 rm "$IDX/tag/$tag/$path" 2>/dev/null
      done
      aws s3 ls "$IDX/" --recursive | awk '{print $4}' | grep "/$path$" \
        | xargs -I{} aws s3 rm "s3://$B/{}" 2>/dev/null
    done
aws s3 rm "$FILES/$DIR" --recursive
```

---

## Error Handling

| Situation | Detection | Action |
|-----------|-----------|--------|
| File not found | `head-object` returns 404 | Stop, report missing path |
| Credentials invalid | `aws s3 ls` returns `AccessDenied` | Stop, report env var issue |
| Endpoint unreachable | Connection refused or timeout | Run health check, report |
| File too large | `wc -c` check before upload | Refuse upload, report size |
| Index write fails | Non-zero exit from `aws s3 cp -` | Log warning, run reconcile |
| Partial move (crash) | Source and dest both exist | Remove source, rebuild dest index |

**After any unexpected exit, run reconciliation** to restore index consistency.

---

## Advanced: Conditional Write (Optimistic Locking)

For metadata files that multiple agents might update:

```bash
# Read current ETag
ETAG=$(aws s3api head-object --bucket "$B" --key "$P/<meta-key>" \
  --query 'ETag' --output text | tr -d '"')

# Write only if object hasn't changed (AWS S3 conditional write, Nov 2024+)
aws s3api put-object \
  --bucket "$B" \
  --key "$P/<meta-key>" \
  --body /tmp/updated.json \
  --if-match "$ETAG"
# Exit code 0 = success; non-zero = another agent wrote first → retry
```

Note: `if-match` on `PutObject` requires AWS S3 (not all MinIO versions support it).
For MinIO, use a dedicated lock file or accept eventual consistency.

---

## Advanced: Presigned URLs

Share a file with users or external services without exposing credentials:

```bash
aws s3 presign "$FILES/knowledge-base/originals/contracts/agreement.pdf" \
  --expires-in 3600
# Returns a time-limited HTTPS URL valid for 1 hour
```

This is a native S3 capability not available in the plugin-based file-store.

---

## Advanced: S3 Versioning (AWS S3 only)

Enable bucket versioning to keep file history:

```bash
# Enable (one-time, bucket owner)
aws s3api put-bucket-versioning \
  --bucket "$B" \
  --versioning-configuration Status=Enabled

# List versions of a file
aws s3api list-object-versions \
  --bucket "$B" \
  --prefix "$P/files/$O/knowledge-base/markdown/engineering/spec.md"

# Restore a previous version
aws s3api get-object \
  --bucket "$B" \
  --key "$P/files/$O/knowledge-base/markdown/engineering/spec.md" \
  --version-id "<version-id>" \
  /tmp/restored.md
```

---

## Performance Notes

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Read file | O(1) | Direct key lookup |
| Write file | O(tags) | One PUT per tag + 2 for date/author |
| Search by tag | O(log n) | S3 prefix scan |
| Search by name | O(n) | Full list + grep |
| Search by 2 tags (AND) | O(log n) × 2 | Two prefix scans + `comm` |
| Remove file | O(tags + log n) | Read metadata + scan idx for stragglers |
| Reconcile | O(n × tags) | Full scan — run only when needed |

For stores with >10,000 files, name-pattern search (full scan) will be slow.
Prefer tag-based search for regular queries.
