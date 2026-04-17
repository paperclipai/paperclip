# Data Exports

Paperclip provides cost and finance data export capabilities for external analysis, reconciliation, and business intelligence integration.

## Cost Events Export

Export detailed billing data including token usage, provider attribution, and cost breakdown.

### Endpoint

```
GET /api/companies/{companyId}/costs/export
```

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `format` | `"json" \| "csv"` | No | `"json"` | Export format |
| `from` | ISO datetime | No | - | Start date for filtering |
| `to` | ISO datetime | No | - | End date for filtering |
| `limit` | number | No | `10000` | Maximum records (max: 50000) |

### Response

**JSON format:**
```json
[
  {
    "id": "uuid",
    "agentId": "uuid",
    "agentName": "Agent Name",
    "issueId": "uuid",
    "projectId": "uuid",
    "goalId": "uuid",
    "heartbeatRunId": "uuid",
    "billingCode": "code",
    "provider": "anthropic",
    "biller": "anthropic",
    "billingType": "subscription_included",
    "model": "claude-sonnet-4-5",
    "inputTokens": 1000,
    "cachedInputTokens": 500,
    "outputTokens": 200,
    "costCents": 0,
    "occurredAt": "2026-04-16T14:30:00Z",
    "createdAt": "2026-04-16T14:30:05Z"
  }
]
```

**CSV format:** Headers match JSON field names, delivered as downloadable file.

### Example Usage

```bash
# Export last 30 days as JSON
curl "http://localhost:3100/api/companies/{companyId}/costs/export?from=2026-03-17T00:00:00Z&to=2026-04-16T23:59:59Z" \
  -H "Authorization: Bearer {api_key}"

# Export as CSV for Excel analysis
curl "http://localhost:3100/api/companies/{companyId}/costs/export?format=csv&limit=50000" \
  -H "Authorization: Bearer {api_key}" \
  -o costs.csv
```

## Finance Events Export

Export account-level financial events including credit purchases, fees, refunds, and provisioned capacity charges.

### Endpoint

```
GET /api/companies/{companyId}/costs/finance-export
```

### Query Parameters

Same as cost events export.

### Response

**JSON format:**
```json
[
  {
    "id": "uuid",
    "agentId": "uuid",
    "issueId": "uuid",
    "projectId": "uuid",
    "goalId": "uuid",
    "heartbeatRunId": "uuid",
    "costEventId": "uuid",
    "billingCode": "code",
    "description": "Credit purchase",
    "eventKind": "credit_purchase",
    "direction": "debit",
    "biller": "openrouter",
    "provider": "openrouter",
    "executionAdapterType": "claude_local",
    "pricingTier": "standard",
    "region": "us-east-1",
    "model": null,
    "quantity": 100,
    "unit": "credits",
    "amountCents": 10000,
    "currency": "USD",
    "estimated": false,
    "externalInvoiceId": "inv_123",
    "occurredAt": "2026-04-16T14:30:00Z",
    "createdAt": "2026-04-16T14:30:05Z"
  }
]
```

## Use Cases

### Financial Reconciliation
Export monthly billing data to match against invoices from providers:
```bash
curl "http://localhost:3100/api/companies/{companyId}/costs/export?format=csv&from=2026-04-01T00:00:00Z&to=2026-04-30T23:59:59Z"
```

### BI Tool Integration
Import into Tableau, PowerBI, or Looker for custom dashboards:
```python
import requests
import pandas as pd

response = requests.get(
    f"http://localhost:3100/api/companies/{company_id}/costs/export",
    headers={"Authorization": f"Bearer {api_key}"},
    params={"from": "2026-01-01T00:00:00Z", "limit": 50000}
)
df = pd.DataFrame(response.json())
```

### Budget Forecasting
Analyze historical spend patterns:
```bash
# Get 6 months of data for trend analysis
curl "http://localhost:3100/api/companies/{companyId}/costs/export?format=csv&from=2025-10-01T00:00:00Z" \
  -o historical-costs.csv
```

### Compliance Audits
Maintain billing audit trails with complete event details:
```bash
# Export all finance events for audit period
curl "http://localhost:3100/api/companies/{companyId}/costs/finance-export?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z" \
  -o audit-2026.json
```

## Data Dictionary

### Cost Events Fields

- **provider**: Upstream AI provider (e.g., `anthropic`, `openai`, `google`)
- **biller**: Entity that charged for usage (may differ from provider for aggregators)
- **billingType**: Pricing mode - `metered_api`, `subscription_included`, `subscription_overage`, `credits`, `unknown`
- **cachedInputTokens**: Prompt caching tokens (reduces cost for repeated content)
- **billingCode**: Optional project/task billing code for cost attribution

### Finance Events Fields

- **eventKind**: Type of financial event - `credit_purchase`, `fee`, `refund`, `provisioned_capacity`, `training`, `storage`, etc.
- **direction**: `debit` (charge) or `credit` (refund/offset)
- **estimated**: `true` if amount is estimated, `false` if invoice-authoritative
- **quantity/unit**: For non-inference charges (e.g., `100 credits`, `5 hours`)

## Authentication

All export endpoints require authentication:
- **Board users**: Standard session authentication
- **Agents**: Bearer token with `Authorization: Bearer {PAPERCLIP_API_KEY}`

Exports are company-scoped - users/agents can only export data for companies they have access to.

## Rate Limits

- Maximum 50,000 records per request
- For larger datasets, use multiple requests with date range filtering
- CSV exports include Content-Disposition header for automatic file download

## Notes

- Timestamps are in UTC with timezone info (`YYYY-MM-DDTHH:mm:ss.sssZ`)
- Cost amounts in cents (divide by 100 for dollars)
- NULL values in JSON are omitted from CSV (empty cells)
- CSV escaping follows RFC 4180 standard
