---
name: aws-file-store
alwaysApply: true
description: >
  Corporate knowledge base backed by S3 via AWS CLI — no plugin required.
  Agents use bash commands to read/write files and maintain a prefix-based
  index of 0-byte marker objects for fast tag/author/date search.
  Same directory structure and workflow as the plugin-based file-store.
---

# Corporate Knowledge Base — AWS CLI

## Purpose

Shared persistent knowledge base for all agents and users.
Implemented with **AWS CLI** (`aws s3`, `aws s3api`) — no plugin, no sidecar service.

Supports AWS S3, MinIO, and any S3-compatible backend.

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `FILE_STORE_BUCKET` | S3 bucket name (required) |
| `FILE_STORE_PREFIX` | Key prefix in the bucket (default: `file-store`) |
| `FILE_STORE_ORG` | Org slug override (default: `$PAPERCLIP_COMPANY_ID`) |
| `AWS_ENDPOINT_URL` | S3 endpoint override for MinIO (e.g. `http://minio:9000`) |
| `AWS_ACCESS_KEY_ID` | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key |
| `AWS_DEFAULT_REGION` | AWS region (default: `us-east-1`) |

AWS CLI v2 reads `AWS_ENDPOINT_URL` automatically — no extra flags needed.

**Set these aliases at the start of every file-store session:**

```bash
B="$FILE_STORE_BUCKET"
P="${FILE_STORE_PREFIX:-file-store}"
O="${FILE_STORE_ORG:-$PAPERCLIP_COMPANY_ID}"
FILES="s3://$B/$P/files/$O"
IDX="s3://$B/$P/idx/$O"
```

## Storage Layout

```
s3://$BUCKET/$PREFIX/
├── files/$ORG/                    # Primary file storage
│   ├── knowledge-base/
│   │   ├── originals/<topic>/
│   │   └── markdown/<topic>/
│   └── income/
└── idx/$ORG/                      # Index: 0-byte marker objects
    ├── tag/<tag>/<path>            # One marker per tag per file
    ├── date/<YYYY-MM-DD>/<path>    # One marker per file per creation date
    └── author/<agent_id>/<path>    # One marker per file per author
```

Index entries are **0-byte S3 objects**. Creating one is atomic. Parallel agents
never conflict because each entry is independent — no shared mutable state.

## Directory Structure

```
$ORG/
├── knowledge-base/
│   ├── originals/<topic>/     # Native files (PDF, DOCX, images, etc.)
│   └── markdown/<topic>/      # Markdown-converted versions
└── income/                    # Incoming files pending triage
```

## MANDATORY Rules

1. **Maintain the index on every write and every delete.** Create index entries after
   writing; remove them before deleting. Skipping this breaks search.

2. **Store tags as comma-separated in object metadata** under key `tags`.
   No spaces around commas. Example: `tags=report,finance,q4`.

3. **Check before creating.** Search by tag or name before writing a new file.
   Update existing documents rather than creating duplicates.

4. **Process income files.** When files appear in `income/`, read → convert →
   move to `knowledge-base/` → remove from `income/`.

5. **Prefer `markdown/`** over `originals/` when reading for agent consumption.

6. **50 MB limit.** Validate before uploading:
   ```bash
   size=$(wc -c < /tmp/file); [ "$size" -gt 52428800 ] && echo "ERROR: file too large" && exit 1
   ```

## Operations

### WRITE

```bash
FILE_PATH="knowledge-base/markdown/engineering/auth-spec.md"
TAGS="auth,specification,engineering"
DESC="Technical specification for the auth service"

# 1. Upload with metadata
aws s3 cp /tmp/auth-spec.md "$FILES/$FILE_PATH" \
  --metadata "createdby=$PAPERCLIP_AGENT_ID,createdat=$(date -u +%Y-%m-%dT%H:%M:%SZ),tags=$TAGS,description=$DESC"

# 2. Tag index entries
for tag in $(echo "$TAGS" | tr ',' ' '); do
  echo -n | aws s3 cp - "$IDX/tag/$tag/$FILE_PATH"
done

# 3. Date and author index entries
echo -n | aws s3 cp - "$IDX/date/$(date +%Y-%m-%d)/$FILE_PATH"
echo -n | aws s3 cp - "$IDX/author/$PAPERCLIP_AGENT_ID/$FILE_PATH"
```

For **binary files** (PDFs, images), base64-encode the content:
```bash
base64 /tmp/report.pdf > /tmp/report.b64
aws s3 cp /tmp/report.b64 "$FILES/knowledge-base/originals/finance/report.pdf" \
  --metadata "createdby=$PAPERCLIP_AGENT_ID,createdat=$(date -u +%Y-%m-%dT%H:%M:%SZ),tags=finance,encoding=base64,description=Q4 financial report"
```

### READ

```bash
# Text file — print to stdout
aws s3 cp "$FILES/knowledge-base/markdown/engineering/auth-spec.md" -

# Binary file — download locally
aws s3 cp "$FILES/knowledge-base/originals/finance/report.pdf" /tmp/report.pdf
```

### LIST

```bash
# Immediate children
aws s3 ls "$FILES/knowledge-base/markdown/"

# Recursive with sizes
aws s3 ls "$FILES/knowledge-base/" --recursive | awk '{print $3, $4}'
```

### TREE

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

### STAT

```bash
aws s3api head-object \
  --bucket "$B" \
  --key "$P/files/$O/knowledge-base/markdown/engineering/auth-spec.md"
# Returns: ContentLength, LastModified, Metadata (createdby, createdat, tags, description)
```

### SEARCH

```bash
# By tag — O(log n) prefix scan, NOT a full bucket scan
aws s3 ls "$IDX/tag/report/" --recursive \
  | awk '{print $4}' | sed "s|$P/idx/$O/tag/report/||"

# By name pattern
aws s3 ls "$FILES/" --recursive \
  | awk '{print $4}' | sed "s|$P/files/$O/||" | grep "auth"

# By tag AND date range — intersect two prefix scans
comm -12 \
  <(aws s3 ls "$IDX/tag/report/"     --recursive | awk '{print $4}' | sed "s|.*/tag/report/||"   | sort) \
  <(aws s3 ls "$IDX/date/2026-04-09/" --recursive | awk '{print $4}' | sed "s|.*/date/[^/]*/||" | sort)

# By author
aws s3 ls "$IDX/author/$PAPERCLIP_AGENT_ID/" --recursive \
  | awk '{print $4}' | sed "s|$P/idx/$O/author/$PAPERCLIP_AGENT_ID/||"
```

### MOVE

```bash
SRC="knowledge-base/markdown/engineering/old-spec.md"
DST="knowledge-base/markdown/engineering/new-spec.md"

# 1. Read current tags
TAGS=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$SRC" \
  --query 'Metadata.tags' --output text)

# 2. Copy to new path
aws s3 cp "$FILES/$SRC" "$FILES/$DST" --metadata-directive COPY

# 3. New index entries
for tag in $(echo "$TAGS" | tr ',' ' '); do
  echo -n | aws s3 cp - "$IDX/tag/$tag/$DST"
done
echo -n | aws s3 cp - "$IDX/date/$(date +%Y-%m-%d)/$DST"
echo -n | aws s3 cp - "$IDX/author/$PAPERCLIP_AGENT_ID/$DST"

# 4. Remove old index entries
for tag in $(echo "$TAGS" | tr ',' ' '); do
  aws s3 rm "$IDX/tag/$tag/$SRC" 2>/dev/null
done
aws s3 ls "$IDX/" --recursive | awk '{print $4}' | grep "/$SRC$" \
  | xargs -I{} aws s3 rm "s3://$B/{}" 2>/dev/null

# 5. Remove old file
aws s3 rm "$FILES/$SRC"
```

### REMOVE

```bash
FILE_PATH="knowledge-base/markdown/engineering/auth-spec.md"

# 1. Read tags before deleting (needed to clean index)
TAGS=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$FILE_PATH" \
  --query 'Metadata.tags' --output text 2>/dev/null)

# 2. Remove all index entries for this path
for tag in $(echo "$TAGS" | tr ',' ' '); do
  aws s3 rm "$IDX/tag/$tag/$FILE_PATH" 2>/dev/null
done
aws s3 ls "$IDX/" --recursive | awk '{print $4}' | grep "/$FILE_PATH$" \
  | xargs -I{} aws s3 rm "s3://$B/{}" 2>/dev/null

# 3. Remove the file
aws s3 rm "$FILES/$FILE_PATH"
```

### HEALTH CHECK

```bash
aws s3 ls "s3://$B/$P/" > /dev/null 2>&1 \
  && echo "S3 reachable" \
  || echo "ERROR: cannot reach S3 — check AWS_ENDPOINT_URL, credentials, bucket name"
```

## Index Reconciliation

Run this when an agent crashed mid-write and the index may be incomplete:

```bash
aws s3 ls "$FILES/" --recursive | awk '{print $4}' | sed "s|$P/files/$O/||" \
  | while read path; do
    tags=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$path" \
      --query 'Metadata.tags' --output text 2>/dev/null)
    author=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$path" \
      --query 'Metadata.createdby' --output text 2>/dev/null)
    date=$(aws s3api head-object --bucket "$B" --key "$P/files/$O/$path" \
      --query 'LastModified' --output text | cut -dT -f1)

    for tag in $(echo "$tags" | tr ',' ' '); do
      echo -n | aws s3 cp - "$IDX/tag/$tag/$path" 2>/dev/null
    done
    echo -n | aws s3 cp - "$IDX/date/$date/$path" 2>/dev/null
    [ -n "$author" ] && echo -n | aws s3 cp - "$IDX/author/$author/$path" 2>/dev/null
  done
echo "Reconciliation complete."
```

## Workflow Examples

### Processing an incoming file (income → knowledge-base)

```bash
# 1. Check income
aws s3 ls "$FILES/income/"

# 2. Download and inspect
aws s3 cp "$FILES/income/vendor-contract.pdf" /tmp/vendor-contract.pdf

# 3. Convert to Markdown (use pdf-converter or pdftotext)
pdftotext /tmp/vendor-contract.pdf /tmp/vendor-contract.md

# 4. Write original
ORIG="knowledge-base/originals/legal/vendor-contract.pdf"
aws s3 cp /tmp/vendor-contract.pdf "$FILES/$ORIG" \
  --metadata "createdby=$PAPERCLIP_AGENT_ID,createdat=$(date -u +%Y-%m-%dT%H:%M:%SZ),tags=contract,vendor,legal,description=Original vendor contract PDF"
for tag in contract vendor legal; do echo -n | aws s3 cp - "$IDX/tag/$tag/$ORIG"; done
echo -n | aws s3 cp - "$IDX/date/$(date +%Y-%m-%d)/$ORIG"
echo -n | aws s3 cp - "$IDX/author/$PAPERCLIP_AGENT_ID/$ORIG"

# 5. Write Markdown
MD="knowledge-base/markdown/legal/vendor-contract.md"
aws s3 cp /tmp/vendor-contract.md "$FILES/$MD" \
  --metadata "createdby=$PAPERCLIP_AGENT_ID,createdat=$(date -u +%Y-%m-%dT%H:%M:%SZ),tags=contract,vendor,legal,converted,description=Markdown version of vendor contract"
for tag in contract vendor legal converted; do echo -n | aws s3 cp - "$IDX/tag/$tag/$MD"; done
echo -n | aws s3 cp - "$IDX/date/$(date +%Y-%m-%d)/$MD"
echo -n | aws s3 cp - "$IDX/author/$PAPERCLIP_AGENT_ID/$MD"

# 6. Remove from income (no index entries for income files)
aws s3 rm "$FILES/income/vendor-contract.pdf"
```

### Finding existing knowledge

```bash
# Find all deployment runbooks
aws s3 ls "$IDX/tag/runbook/" --recursive \
  | awk '{print $4}' | sed "s|$P/idx/$O/tag/runbook/||" | grep "deploy"

# Read the file
aws s3 cp "$FILES/knowledge-base/markdown/ops/deployment-guide.md" -
```

### Check if a file exists

```bash
aws s3api head-object --bucket "$B" --key "$P/files/$O/knowledge-base/markdown/engineering/spec.md" \
  2>&1 | grep -q "404" && echo "NOT FOUND" || echo "EXISTS"
```

## Path Conventions

| Content | Path under `$ORG/` |
|---------|---------------------|
| Incoming file | `income/<filename>` |
| Original file (native format) | `knowledge-base/originals/<topic>/<filename>` |
| Markdown version | `knowledge-base/markdown/<topic>/<filename>.md` |

Topic subdirectories: `engineering/`, `product/`, `ops/`, `marketing/`,
`finance/`, `design/`, `legal/`, `meetings/`, `reference/`

## Full Command Reference

See `skills/aws-file-store/references/commands.md` for error handling, edge cases,
and advanced patterns.
