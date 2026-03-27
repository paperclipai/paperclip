---
name: Build vulnerability management pipeline
assignee: vulnerability-scanner
project: threat-and-compliance-platform
priority: critical
---

## Scope

Implement the end-to-end vulnerability management lifecycle: asset inventory → CVE scan → CVSS scoring → patch prioritisation → Jira ticket creation → SLA tracking → closure verification.

## Deliverables

1. Asset inventory integration with all in-scope systems documented
2. Automated CVE scan schedule (weekly + on-demand)
3. CVSS-based patch prioritisation matrix with SLA tiers
4. Jira integration: auto-create remediation tickets with severity, SLA deadline, and asset details
5. SLA tracking dashboard: open CVEs by severity, days-open, SLA status
6. Closure verification workflow: re-scan after patch, auto-close only on confirmed fix

## Success Criteria

- All in-scope assets covered in vulnerability scanner
- Critical CVEs acknowledged within 2 hours of discovery
- Jira tickets auto-created with correct SLA deadlines
- Zero critical CVEs remain unpatched beyond 48-hour SLA without CEO-approved risk acceptance
- Dashboard visible to CISO and CEO
