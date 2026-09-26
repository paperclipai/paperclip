# GraphQL Analytics API Configuration

## Authentication

### API Token (Recommended)

| Permission | Scope | Use Case |
|------------|-------|----------|
| **Account Analytics: Read** | Account-wide | Workers, R2, KV, D1, DO, AI, Network Analytics |
| **Zone Analytics: Read** | Per-zone | HTTP requests, Firewall, DNS, Load Balancing |
| **All zones - Analytics: Read** | All zones | Multi-zone HTTP/Firewall/DNS queries |

Create tokens at: [dash.cloudflare.com > Account API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)

```bash
# Verify token
curl -s https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"query":"{ viewer { zones(filter: {zoneTag: \"ZONE_ID\"}) { httpRequestsAdaptiveGroups(limit: 1, filter: {datetime_gt: \"2025-01-01T00:00:00Z\"}) { count } } } }"}'
```

### API Key + Email (Legacy)

Not recommended. Use `X-Auth-Email` + `X-Auth-Key` headers instead of `Authorization: Bearer`.

## Client Setup

### curl

```bash
curl -s https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "query": "query($zoneTag: string!, $start: Time!, $end: Time!) { viewer { zones(filter: {zoneTag: $zoneTag}) { httpRequestsAdaptiveGroups(filter: {datetime_gt: $start, datetime_lt: $end}, limit: 10, orderBy: [datetimeFiveMinutes_DESC]) { count dimensions { datetimeFiveMinutes } } } } }",
    "variables": { "zoneTag": "ZONE_ID", "start": "2025-01-01T00:00:00Z", "end": "2025-01-02T00:00:00Z" }
  }' | jq .
```

### TypeScript / JavaScript

```typescript
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

async function queryGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const json = await response.json() as { data: T | null; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data!;
}
```

### Python

```python
import requests, os

def query_graphql(query: str, variables: dict = None) -> dict:
    r = requests.post("https://api.cloudflare.com/client/v4/graphql",
        headers={"Authorization": f"Bearer {os.environ['CF_API_TOKEN']}", "Content-Type": "application/json"},
        json={"query": query, "variables": variables or {}})
    r.raise_for_status()
    result = r.json()
    if result.get("errors"):
        raise Exception("; ".join(e["message"] for e in result["errors"]))
    return result["data"]
```

### From a Cloudflare Worker

Store the API token as a secret (`CF_API_TOKEN`). Use standard `fetch` to POST to `https://api.cloudflare.com/client/v4/graphql` with the same JSON body format as above. Always check `response.errors` — GraphQL returns 200 even on query failures.

## GraphQL API Explorer

Interactive explorer at [graphql.cloudflare.com](https://graphql.cloudflare.com/) — provides schema docs, autocomplete, variable panel, and shareable queries. Authenticates via your Cloudflare dashboard session.

## Schema Introspection

```graphql
# List zone-scoped datasets
{ __type(name: "zone") { fields { name description } } }

# List account-scoped datasets
{ __type(name: "account") { fields { name description } } }

# Discover dimensions for a dataset
{ __type(name: "ZoneHttpRequestsAdaptiveGroupsDimensions") {
  fields { name type { name kind } }
} }

# Discover filter operators for a dataset
{ __type(name: "ZoneHttpRequestsAdaptiveGroupsFilter_InputObject") {
  inputFields { name type { name kind } }
} }
```

## Finding Your Zone and Account IDs

- **Zone ID**: Dashboard > select zone > Overview (right sidebar), or via API
- **Account ID**: Dashboard > Account Home URL, or via API

```bash
curl -s https://api.cloudflare.com/client/v4/zones -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | {name, id}'
curl -s https://api.cloudflare.com/client/v4/accounts -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | {name, id}'
```

## See Also

- [README.md](README.md) - Overview, decision tree, dataset index
- [api.md](api.md) - Query structure, aggregation fields, filtering operators
- [patterns.md](patterns.md) - Common query patterns (time-series, top-N, per-product)
- [gotchas.md](gotchas.md) - Rate limits, sampling, troubleshooting
