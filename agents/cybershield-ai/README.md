# CyberShield AI

> AI-powered continuous threat detection, vulnerability management and compliance auditing for SMBs.

CyberShield AI is an autonomous cybersecurity company that delivers enterprise-grade protection at SMB scale. It operates a continuous security operations model: threat intelligence ingestion, vulnerability lifecycle management, incident response, and compliance evidence gathering — all running autonomously with human-in-the-loop governance gates.

## What This Company Does

1. **Detect** — ThreatEye continuously ingests CVE feeds, Shodan data, and SIEM anomalies, mapping every finding to MITRE ATT&CK techniques
2. **Scan** — VulnBot maps CVEs to assets, prioritises by CVSS, and enforces 48-hour SLA on Critical findings
3. **Respond** — IRBot executes runbooks for confirmed incidents, containing threats and preserving forensic evidence
4. **Govern** — CompliBot maintains continuous ISO 27001, SOC 2 Type II, and GDPR evidence packs
5. **Test** — RedAgent runs monthly penetration test simulations and validates that remediations hold
6. **Educate** — AwareBot runs phishing simulations and security awareness campaigns quarterly
7. **Synthesise** — RiskMind integrates all signals into an executive risk score with board-ready reporting

## Org Chart

| Agent | Title | Reports To | Role |
|---|---|---|---|
| ShieldCEO | Chief Executive Officer | — | CEO (Board Operator, approval gate) |
| ChiefGuard | Chief Information Security Officer | ShieldCEO | CISO — security posture owner |
| ThreatEye | Threat Analyst | ChiefGuard | Threat intelligence and log triage |
| VulnBot | Vulnerability Scanner | ChiefGuard | CVE mapping and patch prioritisation |
| IRBot | Incident Responder | ChiefGuard | Runbook execution and containment |
| CompliBot | Compliance Officer | ShieldCEO | ISO 27001, SOC 2, GDPR evidence |
| RedAgent | Penetration Test Engineer | ShieldCEO | Scheduled attack simulation reports |
| AwareBot | Security Awareness Coach | ShieldCEO | Phishing simulations and staff training |
| RiskMind | Risk Orchestrator | ShieldCEO | Executive risk posture and trend reporting |

### Org Tree

```
ShieldCEO (CEO)
├── ChiefGuard (CISO)
│   ├── ThreatEye (Threat Analyst)
│   ├── VulnBot (Vulnerability Scanner)
│   └── IRBot (Incident Responder)
├── CompliBot (Compliance Officer)
├── RedAgent (Penetration Test Engineer)
├── AwareBot (Security Awareness Coach)
└── RiskMind (Risk Orchestrator)
```

## Teams

| Team | Manager | Members | Focus |
|---|---|---|---|
| Security Operations | ChiefGuard | ThreatEye, VulnBot, IRBot | Threat detection, vuln management, IR |
| Compliance | CompliBot | CompliBot, RiskMind | Audit readiness, risk intelligence |
| Red Team | RedAgent | RedAgent, AwareBot | Pen testing, awareness campaigns |

## Key SLA Commitments

| Metric | Target | Owner |
|--------|--------|-------|
| Critical CVE patch SLA | 48 hours | VulnBot |
| P1 incident CEO escalation | 15 minutes | ChiefGuard |
| Monthly threat intelligence digest | Day 1 of month | ThreatEye |
| SOC 2 evidence completeness | ≥ 80% controls | CompliBot |
| Pen test frequency | Monthly | RedAgent |
| Phishing simulation frequency | Quarterly | AwareBot |
| Risk score target | ≥ 75/100 | RiskMind |

## Approval Gate

**All recommended remediations require CEO board approval before agents file tickets.** This gate is mandatory and provides the audit trail that SOC 2 and ISO 27001 compliance requires.

```
ThreatEye/VulnBot/IRBot
  → recommends remediation
  → ChiefGuard reviews + approves recommendation
  → ShieldCEO board approval required
  → VulnBot/IRBot files Jira ticket
  → Remediation executed
  → VulnBot verifies closure
```

## Projects

### Threat and Compliance Platform (seed project)

Seven seed tasks establish all platform capabilities:

| Task | Assignee | Priority |
|---|---|---|
| Set up threat intelligence pipeline | ThreatEye | Critical |
| Build vulnerability management pipeline | VulnBot | Critical |
| Build incident response playbook library | IRBot | High |
| Establish SOC 2 Type II evidence collection framework | CompliBot | High |
| Set up penetration test automation programme | RedAgent | High |
| Build phishing simulation and awareness campaign framework | AwareBot | Medium |
| Build executive risk posture dashboard | RiskMind | High |

## Recurring Tasks

| Task | Schedule | Assignee |
|---|---|---|
| Daily Threat Intelligence Brief | Daily at 07:00 UTC | ThreatEye |
| Weekly Vulnerability Scan | Monday at 06:00 UTC | VulnBot |
| Monthly Compliance Posture Check | 1st of month at 08:00 UTC | CompliBot |

## Getting Started

Import this company into your Paperclip instance:

```bash
paperclipai company import --from agents/cybershield-ai
```

Or from GitHub:

```bash
paperclipai company import --from https://github.com/paperclipai/paperclip/tree/main/agents/cybershield-ai
```

### Required Secrets

| Agent | Secret | Requirement |
|---|---|---|
| ThreatEye | `SHODAN_API_KEY` | Required — internet exposure intelligence |
| VulnBot | `NVD_API_KEY` | Required — CVE data and CVSS scores |
| ThreatEye | `VIRUSTOTAL_API_KEY` | Optional — IOC reputation lookups |
| IRBot, ChiefGuard | `JIRA_API_KEY` | Optional — remediation ticket creation |
| IRBot, ChiefGuard, RiskMind | `SLACK_WEBHOOK_URL` | Optional — incident and risk notifications |
| IRBot, ChiefGuard | `PAGERDUTY_API_KEY` | Optional — P1/P2 on-call escalation |
| ThreatEye | `SPLUNK_HEC_TOKEN` | Optional — SIEM log ingestion |
| RedAgent | `METASPLOIT_API_KEY` | Optional — pen test automation |

```bash
paperclipai secrets set NVD_API_KEY <your-nvd-key>
paperclipai secrets set SHODAN_API_KEY <your-shodan-key>
```

## References

- [Agent Companies Specification](https://agentcompanies.io/specification)
- [Paperclip](https://github.com/paperclipai/paperclip)
- [MITRE ATT&CK Framework](https://attack.mitre.org/)
- [NVD API](https://nvd.nist.gov/developers/vulnerabilities)
- [SOC 2 Trust Services Criteria](https://www.aicpa.org/resources/landing/trust-services-criteria)
