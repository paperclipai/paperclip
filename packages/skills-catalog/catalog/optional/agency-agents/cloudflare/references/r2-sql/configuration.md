# R2 SQL Configuration

Auth and setup. For the current permission matrix and wrangler flags, pull `https://developers.cloudflare.com/r2-sql/reference/wrangler-commands/` and the R2 Data Catalog manage-catalogs doc.

## Prerequisites

- R2 bucket with Data Catalog enabled ([r2-data-catalog/configuration.md](../r2-data-catalog/configuration.md))
- R2 API token: **R2 Storage Admin Read & Write** (includes R2 SQL Read), or add **R2 SQL Read** explicitly
- Wrangler CLI (for CLI queries)

> Open-beta limitation: R2 Storage **Admin Read & Write is required even for read-only R2 SQL queries**.

## Enable Catalog + Get Warehouse

```bash
npx wrangler r2 bucket catalog enable my-bucket
```

You query by **warehouse** name (`{ACCOUNT_ID}_{BUCKET}`), shown in the output alongside the Catalog URI.

## Configure Auth

### Wrangler CLI

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=<your-token>
# or a .env file in the project dir (auto-loaded): WRANGLER_R2_SQL_AUTH_TOKEN=<your-token>
```

> Wrangler does **not** use the `wrangler login` OAuth session for R2 SQL — the env var is required.

### REST API

```bash
curl -X POST \
  "https://api.sql.cloudflarestorage.com/api/v1/accounts/$ACCOUNT_ID/r2-sql/query/$BUCKET" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "SELECT * FROM default.my_table LIMIT 10"}'
```

## Verify Setup

```bash
npx wrangler r2 sql query "${ACCOUNT_ID}_my-bucket" "SHOW DATABASES"
npx wrangler r2 sql query "${ACCOUNT_ID}_my-bucket" "SHOW TABLES IN default"
```

## See Also

- [api.md](api.md) — SQL syntax · [patterns.md](patterns.md) — query examples · [gotchas.md](gotchas.md) — troubleshooting
