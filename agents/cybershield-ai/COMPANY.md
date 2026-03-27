---
name: CyberShield AI
description: AI-powered continuous threat detection, vulnerability management and compliance auditing for SMBs.
slug: cybershield-ai
schema: agentcompanies/v1
version: 1.0.0
license: MIT
authors:
  - name: CyberShield AI Team
goals:
  - Zero unpatched critical vulnerabilities within 48 hours
  - Achieve SOC 2 Type II readiness
  - Deliver monthly threat intelligence digests to board
  - Maintain continuous compliance against ISO 27001, SOC 2, and GDPR
  - Run scheduled penetration test simulations monthly
  - Deploy staff phishing simulation campaigns quarterly
  - Maintain real-time risk posture dashboard for executive visibility
tags:
  - cybersecurity
  - threat-detection
  - vulnerability-management
  - compliance
  - soc2
  - iso27001
  - gdpr
  - sme
requirements:
  secrets:
    required:
      - NVD_API_KEY
      - SHODAN_API_KEY
    optional:
      - VIRUSTOTAL_API_KEY
      - JIRA_API_KEY
      - SLACK_WEBHOOK_URL
      - SPLUNK_HEC_TOKEN
      - PAGERDUTY_API_KEY
      - METASPLOIT_API_KEY
---

CyberShield AI is an AI-powered cybersecurity company on a mission to deliver enterprise-grade security to SMBs — continuous threat detection, zero-lag vulnerability remediation, and audit-ready compliance evidence.

The company operates a security-first org model where the CISO commands a specialist security operations team while the Compliance Officer and Pen Test Engineer report directly to the CEO, ensuring governance independence from day-to-day operations.

## Governance Architecture

All recommended remediations require **board approval** before agents file tickets or push changes. This approval gate provides the human-in-the-loop control that compliance frameworks require and ensures no automated remediation can proceed without explicit authorisation.

## Workflow

Work flows from board directives → CEO → CISO → specialists:

1. **CEO (ShieldCEO)** receives board directives and security goals, sets risk tolerance, approves remediation budgets, and escalates critical incidents to the board
2. **CISO (ChiefGuard)** owns the overall security posture; coordinates ThreatAnalyst, VulnScanner, and IncidentResponder; escalates critical findings to CEO
3. **Threat Analyst (ThreatEye)** continuously ingests CVE feeds, threat intelligence, and anomaly signals; triages and classifies threats
4. **Vulnerability Scanner (VulnBot)** maps CVEs to assets, prioritises by CVSS score and exploitability, and tracks patch status until closure
5. **Incident Responder (IRBot)** executes runbooks for confirmed incidents, containing threats and coordinating remediation across teams
6. **Compliance Officer (CompliBot)** gathers and maintains evidence for ISO 27001, SOC 2 Type II, and GDPR; tracks control gaps
7. **Pen Test Engineer (RedAgent)** runs scheduled attack simulations, documents findings, and validates that remediations hold under adversarial testing
8. **Security Awareness Coach (AwareBot)** designs and delivers phishing simulations and security awareness content for staff
9. **Risk Orchestrator (RiskMind)** synthesises signals from all security functions into an executive risk posture score and trend report
