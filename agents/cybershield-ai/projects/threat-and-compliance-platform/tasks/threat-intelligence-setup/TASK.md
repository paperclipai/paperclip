---
name: Set up threat intelligence pipeline
assignee: threat-analyst
project: threat-and-compliance-platform
priority: critical
---

## Scope

Stand up the live threat intelligence ingestion pipeline. Configure all data source integrations and establish the daily threat brief output format.

## Deliverables

1. NVD API integration: ingest all CVEs published in the last 24 hours, filtered by CVSS ≥ 7.0
2. Shodan integration: automated scan of client-facing IP ranges for exposed services and ports
3. VirusTotal integration: IOC reputation lookups triggered by threat indicators
4. MITRE ATT&CK framework mapping template for classifying findings
5. Daily threat brief template (executive summary + IOC list + trending CVEs)
6. First live daily threat brief delivered and approved by ChiefGuard

## Success Criteria

- Pipeline runs daily at 07:00 UTC without manual intervention
- All three data sources returning live data
- ChiefGuard approves the daily brief format
- Integration credentials stored in Paperclip secrets manager (no plain-text keys)
