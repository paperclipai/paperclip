---
title: "CyberShield AI — Company Reference"
description: "Complete reference for the CyberShield AI autonomous cybersecurity services agent company"
---

# CyberShield AI

**CyberShield AI** is a reference `agentcompanies/v1` package for an AI-powered cybersecurity services company. It demonstrates how to model a security-first, compliance-driven organisation with continuous threat detection, zero-lag vulnerability remediation, board-gated remediation approvals, and executive risk posture reporting.

**Package location:** `agents/cybershield-ai/`

## At a Glance

| Metric | Target | Owner |
|--------|--------|-------|
| Critical CVE patch SLA | 48 hours | VulnBot (Vulnerability Scanner) |
| P1 incident CEO escalation | 15 minutes | ChiefGuard (CISO) |
| Monthly threat intelligence digest | Day 1 of month | ThreatEye (Threat Analyst) |
| SOC 2 evidence completeness | ≥ 80% controls | CompliBot (Compliance Officer) |
| Pen test frequency | Monthly | RedAgent (Pen Test Engineer) |
| Risk posture score | ≥ 75/100 | RiskMind (Risk Orchestrator) |

---

## Org Structure

### Agents (9 total)

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

### Agent Reference Table

| Slug | Name | Title | Reports To | Primary Mandate |
|------|------|-------|-----------|-----------------|
| `ceo` | ShieldCEO | Chief Executive Officer | — (root) | Board operator, remediation approval gate, risk governance |
| `ciso` | ChiefGuard | Chief Information Security Officer | `ceo` | Security posture ownership, P1/P2 incident command |
| `threat-analyst` | ThreatEye | Threat Analyst | `ciso` | CVE feed ingestion, log triage, MITRE ATT&CK mapping |
| `vulnerability-scanner` | VulnBot | Vulnerability Scanner | `ciso` | CVE-to-asset mapping, patch prioritisation, SLA tracking |
| `incident-responder` | IRBot | Incident Responder | `ciso` | Runbook execution, containment, forensic evidence |
| `compliance-officer` | CompliBot | Compliance Officer | `ceo` | ISO 27001, SOC 2 Type II, GDPR evidence collection |
| `pen-test-engineer` | RedAgent | Penetration Test Engineer | `ceo` | Scheduled attack simulations, findings reports |
| `security-awareness-coach` | AwareBot | Security Awareness Coach | `ceo` | Phishing simulations, staff security training |
| `risk-orchestrator` | RiskMind | Risk Orchestrator | `ceo` | Composite risk scoring, executive risk reports |

### Teams (3 total)

| Team | Manager | Members | Focus |
|------|---------|---------|-------|
| Security Operations | ChiefGuard | ThreatEye, VulnBot, IRBot | Threat detection, vuln management, IR |
| Compliance | CompliBot | CompliBot, RiskMind | Audit readiness, risk intelligence |
| Red Team | RedAgent | RedAgent, AwareBot | Pen testing, awareness campaigns |

---

## Projects

### Threat and Compliance Platform (seed project)

| Task Slug | Assignee | Outcome |
|-----------|---------|---------|
| `threat-intelligence-setup` | ThreatEye | Live CVE/Shodan/VirusTotal ingestion pipeline + daily brief |
| `vuln-management-pipeline` | VulnBot | Asset-linked CVE tracking with CVSS SLA enforcement + Jira integration |
| `incident-response-playbooks` | IRBot | Six runbooks covering all P1–P4 incident types |
| `soc2-evidence-collection` | CompliBot | SOC 2 TSC control matrix + automated evidence collection |
| `pen-test-automation` | RedAgent | First pen test engagement delivered + findings report |
| `phishing-sim-framework` | AwareBot | Campaign library + measurement dashboard + first simulation |
| `risk-dashboard` | RiskMind | Composite risk score dashboard + weekly executive report |

---

## Recurring Tasks

| Task | Cron | Timezone | Assignee | Purpose |
|------|------|----------|---------|---------|
| `daily-threat-brief` | `0 7 * * *` | UTC | ThreatEye | Daily CVE/IOC/SIEM brief for CISO |
| `weekly-vuln-scan` | `0 6 * * 1` | UTC | VulnBot | Weekly vulnerability scan + SLA tracking report |
| `monthly-compliance-check` | `0 8 1 * *` | UTC | CompliBot | Monthly compliance posture check across ISO 27001, SOC 2, GDPR |

---

## Board Approval Gate

Every recommended remediation requires CEO board approval before agents act. This gate is the foundation of the company's compliance audit trail.

```
ThreatEye/VulnBot → discovers finding
ChiefGuard → reviews and recommends remediation
ShieldCEO (board approval) → approves
VulnBot/IRBot → files Jira ticket + executes
VulnBot → verifies closure
```

Without board approval, no agent may file a ticket, push a patch, or execute a containment action.

---

## Governance Architecture

### Why CompliBot, RedAgent, AwareBot, and RiskMind report to CEO

These four agents are governance functions that must have independence from the CISO's security operations team they oversee or assess. Reporting to CEO gives them authority to escalate findings directly and ensures their outputs are unfiltered by operational concerns.

### Incident Severity Framework

| Priority | Definition | Auto-Remediate | Escalation SLA |
|----------|-----------|---------------|----------------|
| P1 | Active breach / data exfiltration | No | CEO within 15 min |
| P2 | Critical exposure / ransomware risk | No | CEO within 1 hour |
| P3 | Exploitable vulnerability / anomaly | Yes (runbook) | CISO weekly review |
| P4 | Informational finding | Yes (scheduled) | Log only |

### Compliance Coverage

| Framework | Scope | Evidence Owner |
|-----------|-------|---------------|
| ISO 27001 | Full ISMS scope | CompliBot |
| SOC 2 Type II | Security + Availability TSCs | CompliBot |
| GDPR | EU personal data processing | CompliBot |

---

## Risk Scoring Model

RiskMind calculates a composite risk score (0–100, higher is better) from four weighted inputs:

| Input Domain | Weight | Data Source |
|-------------|--------|------------|
| Vulnerability posture | 30% | VulnBot (open CVEs, SLA breaches) |
| Threat intelligence | 25% | ThreatEye (active campaigns, IOC hits) |
| Incident history | 25% | IRBot (frequency, severity, MTTR) |
| Compliance posture | 20% | CompliBot (control gaps, audit readiness) |

Target: ≥ 75. Alert threshold: < 60 (immediate CEO notification).

---

## Required Secrets

| Secret | Required For | Requirement |
|--------|-------------|-------------|
| `NVD_API_KEY` | VulnBot | Required — CVE data and CVSS scores |
| `SHODAN_API_KEY` | ThreatEye | Required — internet exposure intelligence |
| `VIRUSTOTAL_API_KEY` | ThreatEye | Optional — IOC reputation lookups |
| `JIRA_API_KEY` | VulnBot, IRBot | Optional — remediation ticket creation |
| `SLACK_WEBHOOK_URL` | ChiefGuard, IRBot, RiskMind | Optional — incident and risk notifications |
| `PAGERDUTY_API_KEY` | ChiefGuard, IRBot | Optional — P1/P2 on-call escalation |
| `SPLUNK_HEC_TOKEN` | ThreatEye | Optional — SIEM log ingestion |
| `METASPLOIT_API_KEY` | RedAgent | Optional — pen test automation |

---

## Getting Started

### 1. Import the company

```bash
paperclipai company import --from agents/cybershield-ai
```

Or from GitHub:

```bash
paperclipai company import --from https://github.com/paperclipai/paperclip/tree/main/agents/cybershield-ai
```

### 2. Configure required secrets

```bash
paperclipai secrets set NVD_API_KEY <your-nvd-key>
paperclipai secrets set SHODAN_API_KEY <your-shodan-key>
```

### 3. Start the Threat and Compliance Platform project

Begin with `threat-intelligence-setup` (ThreatEye) and `vuln-management-pipeline` (VulnBot) — these establish the live data feeds and tracking infrastructure that all other tasks depend on.

### 4. Run schema tests

```bash
vitest run tests/cybershield-ai/schema.test.ts
```

---

## Testing

```bash
vitest run tests/cybershield-ai/schema.test.ts
```

The test suite covers:
- Top-level package file existence
- COMPANY.md frontmatter validation
- All 9 AGENTS.md files (name, title, reportsTo, paperclip skill)
- Org tree integrity (no cycles, correct reporting lines)
- All 3 TEAM.md files
- Threat and Compliance Platform project + 7 seed tasks
- 3 recurring tasks (portable: `recurring: true`, no schedule block)
- `.paperclip.yaml` (heartbeat config × 9 agents, 3 routines, secret declarations)
- README.md structure (Org Chart, Getting Started, SLA commitments, approval gate)
- Agent-specific content (CVSS, MITRE ATT&CK, runbooks, ISO 27001, OWASP)
