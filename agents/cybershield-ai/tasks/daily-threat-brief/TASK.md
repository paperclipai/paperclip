---
name: Daily Threat Intelligence Brief
assignee: threat-analyst
recurring: true
---

Compile and deliver the daily threat intelligence brief to ChiefGuard and ShieldCEO.

## Checklist

1. Query NVD API for CVEs published or updated in the last 24 hours with CVSS ≥ 7.0
2. Check Shodan for any new exposures on monitored IP ranges
3. Query VirusTotal for any IOC hits on monitored domains, IPs, or file hashes
4. Review SIEM anomaly alerts from the prior 24 hours
5. Classify each finding by MITRE ATT&CK technique and severity (P1–P4)
6. Draft executive summary: top 3 threats, trending CVEs, active campaigns
7. Post brief as a comment on this task and @-mention ChiefGuard for review
8. Escalate any P1/P2 findings immediately — do not wait for the daily brief cycle
