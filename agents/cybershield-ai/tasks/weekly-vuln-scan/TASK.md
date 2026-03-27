---
name: Weekly Vulnerability Scan
assignee: vulnerability-scanner
recurring: true
---

Run the weekly authenticated vulnerability scan across all in-scope assets and produce the patch status report.

## Checklist

1. Run authenticated scan against all in-scope asset inventory
2. Cross-reference new scan results against NVD for CVSS scores
3. Identify new Critical/High findings since last scan
4. Update SLA tracking: flag any Critical findings approaching or past the 48-hour SLA
5. Create Jira remediation tickets for all new Critical/High findings (pending CEO approval gate)
6. Produce weekly vulnerability trend report: new findings, closed findings, SLA adherence rate
7. Post report as task comment and @-mention ChiefGuard for review
8. Escalate any Critical finding that cannot be patched within 48 hours to ChiefGuard for risk-acceptance decision
