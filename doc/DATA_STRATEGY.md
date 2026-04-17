# Paperclip Data Strategy

**Version:** 1.0  
**Date:** 2026-04-17  
**Owner:** Chief Data Officer

## Executive Summary

This document outlines Paperclip's data infrastructure strategy, governance policies, and improvement roadmap. It ensures data quality, compliance, performance, and business value as the platform scales.

## Current Data Infrastructure

### Database Architecture

**Primary Database:** PostgreSQL 17+
- **Embedded mode:** Auto-managed PGlite for development
- **Production:** Supabase or self-hosted PostgreSQL
- **ORM:** Drizzle ORM with type-safe queries
- **Migration strategy:** Versioned migrations in `packages/db/drizzle`

### Core Data Domains

1. **Billing & Finance** ✅ Mature
   - `cost_events` - Request-scoped usage and costs
   - `finance_events` - Account-level financial transactions
   - Export capabilities: CSV/JSON with date filtering

2. **Work Management**
   - `issues` - Task and project tracking
   - `projects`, `goals` - Organizational hierarchy
   - `issue_comments`, `issue_documents` - Collaboration

3. **Agent Operations**
   - `agents` - Agent definitions and configuration
   - `heartbeat_runs` - Execution traces
   - `agent_api_keys` - Authentication credentials

4. **Governance**
   - `approvals` - Decision workflows
   - `budget_policies`, `budget_incidents` - Cost controls
   - `activity_log` - Audit trail

## Data Quality Standards

### Data Integrity

**Required:**
- All foreign keys have indexes
- Cascade deletes where appropriate
- NOT NULL on critical fields
- Unique constraints on identifiers

**Current Status:** ✅ Well-implemented across schema

### Data Validation

**Input Validation:**
- Zod schemas in `packages/shared/src/validators`
- Runtime validation at API boundaries
- Type-safe queries via Drizzle

**Recommendations:**
1. Add CHECK constraints for enum-like fields
2. Implement data quality monitoring dashboard
3. Regular constraint violation audits

## Performance Strategy

### Current Indexes

**Cost Events:** ✅ Well-indexed
```sql
- (company_id, occurred_at)
- (company_id, agent_id, occurred_at)
- (company_id, provider, occurred_at)
- (company_id, biller, occurred_at)
- (company_id, heartbeat_run_id)
```

**Finance Events:** ✅ Comprehensive coverage
```sql
- (company_id, occurred_at)
- (company_id, biller, occurred_at)
- (company_id, event_kind, occurred_at)
- (company_id, direction, occurred_at)
```

### Query Performance

**Export Queries:**
- Limited to 50K records per request
- Timestamp-based filtering required
- Efficient ORDER BY occurred_at DESC

**Monitoring Needs:**
- Slow query logging (>1s)
- Index usage statistics
- Table bloat monitoring

## Data Retention Policy

### Current State
⚠️ **No formal retention policy implemented**

### Recommended Policy

| Data Category | Retention Period | Rationale |
|---------------|------------------|-----------|
| Cost events | 7 years | Tax/compliance requirements |
| Finance events | 10 years | Financial record keeping |
| Heartbeat runs | 90 days | Operational debugging |
| Activity log | 3 years | Audit trail requirements |
| Issue comments | Indefinite | Institutional knowledge |
| Agent API keys (revoked) | 1 year | Security audit trail |

### Implementation Plan

1. **Phase 1:** Add `retention_policy` metadata to schema
2. **Phase 2:** Implement archive job (`archived_at` timestamp)
3. **Phase 3:** Automated cleanup scripts in `scripts/data-retention/`
4. **Phase 4:** Cold storage for archived data

## Security & Compliance

### Data Access Control

**Current:** ✅ Strong
- Company-scoped access enforced at route level
- Agent keys cannot access other companies
- Board users have full company access
- Row-level security via query filters

### Sensitive Data

**PII Handling:**
- User emails in `auth` table
- Agent configurations may contain credentials
- Issue comments may contain sensitive content

**Encryption:**
- ✅ At rest: Managed by database provider
- ✅ In transit: HTTPS/TLS for all API calls
- ⚠️ Application-level encryption: Not implemented for secrets

### Recommendations

1. **Secrets Management:**
   - Migrate to dedicated secrets table (✅ exists: `company_secrets`)
   - Encrypt secret values at application layer
   - Rotate secrets on access revocation

2. **Audit Logging:**
   - Ensure all data access logged in `activity_log`
   - Include actor, timestamp, operation, affected records
   - Retain audit logs per compliance requirements

## Data Observability

### Current Monitoring

✅ **Available:**
- Cost/spend tracking via dashboard
- Budget utilization alerts
- Provider quota windows

⚠️ **Missing:**
- Query performance metrics
- Data quality dashboards
- Schema drift detection
- Backup/restore verification

### Recommended Dashboards

1. **Data Health Dashboard**
   - Table sizes and growth rates
   - Index hit rates
   - Constraint violations
   - Orphaned records

2. **Query Performance Dashboard**
   - Slowest queries (p95, p99)
   - Most frequent queries
   - Index usage statistics
   - Connection pool metrics

3. **Data Quality Dashboard**
   - Null rate tracking
   - Outlier detection (cost anomalies)
   - Referential integrity checks
   - Duplicate detection

## Backup & Recovery

### Current State
⚠️ **Backup strategy undocumented**

### Recommended Strategy

**Production Backups:**
- **Frequency:** Continuous WAL archiving + daily snapshots
- **Retention:** 30 days point-in-time recovery
- **Storage:** Separate region from primary database
- **Testing:** Monthly restore drills

**Development/Staging:**
- **Frequency:** Weekly snapshots
- **Retention:** 7 days
- **Purpose:** Rapid environment refresh

**Recovery Objectives:**
- **RTO (Recovery Time):** < 4 hours
- **RPO (Recovery Point):** < 15 minutes
- **Testing:** Quarterly disaster recovery exercises

## Data Export & Portability

### Current Capabilities

✅ **Cost/Finance Exports** (Implemented 2026-04-17)
- CSV and JSON formats
- Date range filtering
- Up to 50K records per export
- API: `/api/companies/:id/costs/export`
- Documentation: `doc/DATA_EXPORTS.md`

### Future Enhancements

1. **Company Portability** (Existing)
   - Full company export/import
   - CEO-safe import with collision handling
   - Agents, skills, projects, issues

2. **Streaming Exports**
   - For exports >50K records
   - Paginated downloads
   - Background job processing

3. **Data Warehouse Integration**
   - Snowflake/BigQuery connectors
   - Incremental sync support
   - Schema evolution handling

## Analytics & BI

### Current Analytics

✅ **Costs Dashboard**
- Spend by agent, provider, model
- Subscription vs. metered usage
- Token consumption tracking
- Budget utilization

⚠️ **Missing:**
- Agent productivity metrics
- Issue velocity tracking
- Approval bottleneck analysis
- Cost per completed issue

### Recommended Metrics

1. **Operational Metrics**
   - Issues completed per day/week
   - Average issue completion time
   - Blocked issue duration
   - Agent utilization rate

2. **Financial Metrics**
   - Cost per issue (by priority)
   - Cost efficiency trends
   - Budget burn rate forecasting
   - Provider cost comparison

3. **Quality Metrics**
   - Rework rate (reopened issues)
   - Approval rejection rate
   - Comment volume per issue
   - Agent error rates

## Data Governance

### Data Ownership

| Domain | Owner | Stakeholders |
|--------|-------|--------------|
| Billing/Finance | CDO | CFO, Board |
| Work Management | Product | CEO, Managers |
| Agent Operations | CTO | Engineering |
| Governance | CEO | Board |

### Change Management

**Schema Changes:**
1. RFC document for major changes
2. Migration testing in staging
3. Backward compatibility for 1 release
4. Deprecation notices >30 days

**Data Migration:**
1. Validate data integrity before/after
2. Rollback plan required
3. Stakeholder approval for production
4. Monitor for 48hrs post-migration

## Improvement Roadmap

### Q2 2026 (Current)

- ✅ Cost/finance data exports
- ✅ CSV export utility
- ✅ Export API documentation
- ⬜ Data retention policy implementation
- ⬜ Slow query monitoring

### Q3 2026

- ⬜ Data quality dashboard
- ⬜ Automated backup verification
- ⬜ Application-level encryption for secrets
- ⬜ Query performance optimization audit
- ⬜ Archive old heartbeat runs (>90 days)

### Q4 2026

- ⬜ Data warehouse integration
- ⬜ Advanced analytics dashboard
- ⬜ Streaming export API
- ⬜ Schema evolution tracking
- ⬜ Disaster recovery testing program

### 2027

- ⬜ Machine learning for cost forecasting
- ⬜ Anomaly detection for data quality
- ⬜ Real-time data pipeline
- ⬜ Multi-region data residency
- ⬜ Advanced compliance reporting

## Success Metrics

### Data Infrastructure Health

**Target SLOs:**
- Query performance: p95 < 100ms
- Data availability: 99.95%
- Backup success rate: 100%
- Data export availability: 99.9%

**Operational Metrics:**
- Zero data loss incidents
- Mean time to restore: < 4 hours
- Data quality score: > 95%
- Schema change success rate: 100%

## Appendices

### A. Schema Documentation

See: `packages/db/src/schema/` for detailed schema definitions

### B. API Documentation

- **Cost Exports:** `doc/DATA_EXPORTS.md`
- **API Reference:** `doc/API.md`

### C. Migration Guide

See: `doc/DATABASE.md` for migration procedures

### D. Contact

**Data Issues:** Report to CDO via Paperclip issue tracking  
**Emergency:** Data loss or breach - immediate board notification

---

**Document History:**
- 2026-04-17: v1.0 - Initial data strategy (CDO)
