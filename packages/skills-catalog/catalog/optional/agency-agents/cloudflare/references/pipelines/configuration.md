# Pipelines Configuration

Templates for creating streams, sinks, and pipelines via CLI, REST, or Terraform. For the full flag/field list and allowed values, pull `https://developers.cloudflare.com/pipelines/reference/wrangler-commands/` and the streams/sinks/pipelines docs.

## Naming Rules

- **Streams, sinks, pipelines** use underscores: `my_stream`, `my_sink`, `my_pipeline`.
- **Buckets** use hyphens: `my-bucket`.

## Schema (Structured Streams)

Schema is a JSON object with a `fields` array; each field has `name`, `type`, `required`.

```json
{
  "fields": [
    { "name": "event_id", "type": "string", "required": true },
    { "name": "amount", "type": "float64", "required": false }
  ]
}
```

Field types include `string`, `bool`, `int32/64`, `float32/64`, `timestamp`, `json`, `binary`, `list`, `struct` (with nested `items`/`fields`). For the authoritative type list, see `https://developers.cloudflare.com/pipelines/sql-reference/sql-data-types/`.

Unstructured streams (no schema) store everything in a single `value` column.

> Pipelines auto-adds `__ingest_ts` (TIMESTAMP, day-partitioned). Do **not** include it in your schema.

## Option A: Interactive (Simplest)

```bash
npx wrangler pipelines setup   # creates stream + sink + pipeline, optionally bucket + catalog
```

## Option B: Wrangler CLI (Explicit)

```bash
# 1. Stream
npx wrangler pipelines streams create my_stream --schema-file schema.json

# 2. Sink — R2 Data Catalog (Iceberg). Creates the namespace + table.
npx wrangler pipelines sinks create my_sink \
  --type r2-data-catalog \
  --bucket my-bucket --namespace my_namespace --table my_table \
  --catalog-token $API_TOKEN \
  --compression zstd --roll-interval 300

# 2b. Sink — R2 raw Parquet (alternative)
npx wrangler pipelines sinks create my_sink \
  --type r2 --bucket my-bucket --format parquet \
  --path analytics/events --partitioning "year=%Y/month=%m/day=%d" \
  --access-key-id $KEY --secret-access-key $SECRET

# 3. Pipeline (SQL connects stream → sink)
npx wrangler pipelines create my_pipeline \
  --sql "INSERT INTO my_sink SELECT * FROM my_stream"
```

Tuning knobs (`--compression`, `--roll-interval`, `--roll-size`, etc.) and their allowed values/defaults change — pull the wrangler-commands and sinks docs rather than hardcoding. Rule of thumb: prod `--roll-interval 300+`, dev `10` (creates many small files).

> **⚠️ Pipelines are immutable.** SQL, schema, and sink config can't be changed — delete and recreate.

## Option C: REST API (Programmatic)

Base: `https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pipelines/v1`

```bash
# Stream
curl -X POST "$BASE_URL/streams" -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" -d '{
    "name": "my_stream",
    "http": {"enabled": true, "authentication": false},
    "schema": {"fields": [{"name": "event_id", "type": "string", "required": true}]}
  }'

# Sink — NOTE REST field names differ from CLI flags (see table)
curl -X POST "$BASE_URL/sinks" -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" -d '{
    "name": "my_sink", "type": "r2_data_catalog",
    "config": {"bucket": "my-bucket", "namespace": "my_namespace",
               "table_name": "my_table", "token": "'$API_TOKEN'",
               "rolling_policy": {"interval_seconds": 300}},
    "format": {"type": "parquet"}
  }'

# Pipeline
curl -X POST "$BASE_URL/pipelines" -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my_pipeline", "sql": "INSERT INTO my_sink SELECT * FROM my_stream;"}'
```

**REST field names ≠ CLI flags** (common failure — not obvious from docs):

| REST (config body) | CLI flag | Gotcha |
|--------------------|----------|--------|
| `"type": "r2_data_catalog"` | `--type r2-data-catalog` | underscores vs hyphens |
| `"table_name"` | `--table` | different key |
| `"token"` | `--catalog-token` | different key |
| `"format": {"type": "parquet"}` | (implied) | required in REST, omitted in CLI |

## Worker Binding

```jsonc
// wrangler.jsonc
{ "pipelines": [ { "stream": "<STREAM_ID>", "binding": "MY_STREAM" } ] }
```

> Binding field is `"stream"` as of June 2026 (was `"pipeline"`, still accepted). Use the **stream ID** (`wrangler pipelines streams list`), not the pipeline ID. Redeploy after adding. Generate typed bindings with `npx wrangler types` → `Pipeline<Cloudflare.MyStreamRecord>` from `cloudflare:pipelines`.

## Terraform

Resources: `cloudflare_pipeline_stream`, `cloudflare_pipeline_sink`, `cloudflare_pipeline`. For current attribute schemas pull `https://developers.cloudflare.com/pipelines/reference/terraform/`.

```hcl
resource "cloudflare_pipeline_stream" "my_stream" {
  account_id     = var.cloudflare_account_id
  name           = "my_stream"
  format         = { type = "json" }
  schema         = { fields = [{ name = "value", type = "json", required = true }] }
  http           = { enabled = true, authentication = false, cors = {} }
  worker_binding = { enabled = false }
}

resource "cloudflare_pipeline_sink" "my_sink" {
  account_id = var.cloudflare_account_id
  name       = "my_sink"
  type       = "r2_data_catalog"
  format     = { type = "parquet" }
  schema     = { fields = [] }
  config     = {
    account_id = var.cloudflare_account_id
    bucket     = cloudflare_r2_bucket.pipeline_bucket.name
    table_name = "my_table"
    token      = var.catalog_token
  }
}

resource "cloudflare_pipeline" "my_pipeline" {
  account_id = var.cloudflare_account_id
  name       = "my_pipeline"
  sql        = "INSERT INTO ${cloudflare_pipeline_sink.my_sink.name} SELECT * FROM ${cloudflare_pipeline_stream.my_stream.name}"
}
```

## Credentials

| Type | Permission |
|------|------------|
| Catalog token (Iceberg sink) | R2 Storage Admin R&W + R2 Data Catalog R&W |
| R2 credentials (raw sink) | Object Read & Write |
| HTTP ingest token | Workers Pipelines Send (only if stream auth enabled) |

## See Also

- [api.md](api.md) — sending events, REST API, lifecycle · [gotchas.md](gotchas.md) — immutability, REST≠CLI
