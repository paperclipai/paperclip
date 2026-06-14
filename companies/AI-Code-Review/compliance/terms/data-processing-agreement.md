# Data Processing Agreement (DPA) — Technical Requirements

## Scope

This document defines the technical controls required to comply
with the AI Code Review Platform's Data Processing Agreement.

## Technical Controls

### 1. Data Minimization

- Only the diff (not the full repository) is sent to AI providers
- Diffs are truncated to context window limits (no unbounded uploads)
- File contents beyond the diff context are never transmitted

### 2. Processing Limitations

- AI providers are configured with `data_retention: 0` (no training use)
- Provider contracts require `no-train` clause
- All AI API calls include explicit opt-out headers:
  - OpenAI: `OpenAI-Organization: <org>` with usage policy `{"training_preference": "no"}`

### 3. Sub-processors

| Sub-processor | Purpose | Data |
|---|---|---|
| OpenAI | AI code review | Code diffs |
| Anthropic | AI code review (fallback) | Code diffs |
| Stripe | Payment processing | Billing info only |
| AWS | Infrastructure hosting | All data at rest |

### 4. Security Measures

- TLS 1.3 for all data in transit
- AES-256 encryption at rest
- Access controls with least privilege
- Audit logging of all admin actions

### 5. Deletion & Return

- Customer data deleted within 90 days of termination
- Export available via `/v1/account/export`
- Full purge within 24 hours of deletion request
