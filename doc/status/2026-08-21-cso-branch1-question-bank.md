# Security Assessment — W7 Branch 1: Breach and Incident History

**Prepared by:** CSO (Agent 19828a0f-a7cf-4363-b9a2-6c058f321203)
**Date:** 2026-08-21
**Status:** Superseded — see doc/security/w7-branch1-breach-incident-history.md (v2.0)
**Assessment Framework:** Praxis M&A Security Due Diligence — Branch 1 of 7

---

## Scoring Guide

Each question is answered: **PASS** / **FAIL** / **UNDETERMINED**

| Score | Meaning | Risk Value Range |
|-------|---------|------------------|
| PASS | Target meets or exceeds standard | 0–2 |
| UNDETERMINED | Insufficient evidence, needs further investigation | 3–5 |
| FAIL | Target has material deficiency | 6–10 |

**Total Risk Score:** Sum of all question risk values.
**Thresholds:** 0–29 Low Risk | 30–79 Medium Risk | 80+ High Risk

---

## Section 1: Known Breach History

### Q1.1 — Public Breach Disclosure
**Question:** Has the target company publicly disclosed any data breach or security incident in the past 5 years?

**Context:** Public disclosure obligations vary by jurisdiction (GDPR 72h, state breach notification laws). This establishes baseline breach awareness.

**Relevant Cases:**
- Yahoo (2016): Disclosed 2013 breach affecting 1B accounts 3 years after it occurred; later revealed all 3B accounts compromised
- Marriott/Starwood (2018): Discovered 2018, traced back to 2014 — 500M guests affected
- Uber (2016): Concealed 2017 breach of 57M users, paid $100k ransom to silence hackers

**Scoring:**
- PASS: No known breaches in past 5 years, or all disclosed within regulatory timelines
- FAIL: Known breach with delayed or non-compliant disclosure
- UNDETERMINED: Cannot confirm disclosure compliance without records audit

**Risk Value:** ____ (0–10)

---

### Q1.2 — Scope of Data Exposed
**Question:** What categories of data were exposed in each known breach?

**Context:** The type of data determines regulatory severity, notification cost, and long-term liability. PII (personally identifiable information), PHI (protected health information), and financial data have escalating severity.

**Relevant Cases:**
- Yahoo: Names, email addresses, telephone numbers, dates of birth, password hashes (MD5), security questions/answers
- Marriott: Passport numbers, payment card numbers and expiry dates, travel records
- Equifax (2017): 147M — SSNs, driver's license numbers, credit card numbers, dispute documents with PII
- Target (2013): 70M — payment card numbers, customer names, email addresses

**Scoring:**
- PASS: Only low-sensitivity data exposed (usernames, preferences) in isolated incident
- FAIL: High-sensitivity data exposed (SSNs, payment cards, medical records, credentials)
- UNDETERMINED: Breach scope not fully determined

**Risk Value:** ____ (0–10)

---

### Q1.3 — Number of Affected Individuals
**Question:** How many individuals were affected by the breach(es)?

**Context:** Volume determines regulatory penalties (GDPR fines up to 4% of global turnover), notification cost, class-action exposure, and reputational damage.

**Relevant Cases:**
- Yahoo: 3 billion (all user accounts)
- Marriott: 500 million
- Equifax: 147 million
- Target: 70 million
- Uber: 57 million

**Scoring:**
- PASS: < 10,000 affected or no breach
- FAIL: > 1,000,000 affected
- UNDETERMINED: Cannot verify count

**Risk Value:** ____ (0–10)

---

### Q1.4 — Breach Detection Method
**Question:** How was the breach detected (internal detection vs. external disclosure)?

**Context:** Internal detection indicates mature security monitoring. External discovery (law enforcement, journalists, researchers) suggests monitoring gaps.

**Relevant Cases:**
- Marriott: Discovered by internal security tool during database access audit
- Equifax: Discovered internally after certificate expiration broke monitoring
- Target: Detected by FireEye but not acted upon until USSS notified
- Yahoo: Discovered by law enforcement during investigation of unrelated parties

**Scoring:**
- PASS: Breach detected by internal security team or automated systems
- FAIL: Breach discovered by external party (journalist, researcher, law enforcement)
- UNDETERMINED: Detection method unclear

**Risk Value:** ____ (0–10)

---

## Section 2: Disclosure Patterns

### Q2.1 — Timeliness of Disclosure
**Question:** Did the company disclose the breach within legally required timeframes?

**Context:** GDPR requires notification within 72 hours. Most US state laws require notification within 30–60 days. SEC cybersecurity rules (2024) require Form 8-K within 4 business days for material incidents.

**Relevant Cases:**
- Yahoo: Delayed 3 years (2013 → 2016). SEC fined $35M for misleading investors
- Uber (2016): Concealed breach for 1+ year, paid $148M settlement
- Equifax: CEO sold shares before disclosure; disclosed publicly ~6 weeks post-discovery

**Scoring:**
- PASS: All breaches disclosed within regulatory timeframes
- FAIL: Any breach disclosed late, concealed, or with misleading public statements
- UNDETERMINED: Disclosure timelines unverifiable

**Risk Value:** ____ (0–10)

---

### Q2.2 — Regulatory Penalties
**Question:** Has the company been fined or penalized by regulators for breach-related violations?

**Context:** Prior regulatory action indicates systemic compliance failures and creates precedent for future enforcement.

**Relevant Cases:**
- Yahoo: $35M SEC fine, $80M class-action settlement, $117.5M data breach settlement
- Equifax: $700M+ total (FTC $425M, CFPB $100M, state AGs $175M)
- Marriott: £18.4M ICO fine (UK), $52M combined EU fines
- Uber: $148M settlement (all 50 states + DC)
- Target: $18.5M state AG settlement, $10M class action

**Scoring:**
- PASS: No regulatory penalties for breaches
- FAIL: Material fines (> $1M) or consent decrees imposed
- UNDETERMINED: Regulatory status unclear

**Risk Value:** ____ (0–10)

---

### Q2.3 — Shareholder/Investor Litigation
**Question:** Has the company faced shareholder derivative lawsuits or securities class actions related to breach disclosure?

**Context:** Securities litigation signals materiality of breach impact on valuation and governance failures around disclosure.

**Relevant Cases:**
- Yahoo: Securities class action alleging misleading statements about data security
- Equifax: Multiple shareholder lawsuits, SEC enforcement action
- Uber: Shareholder derivative suits over breach cover-up
- Capital One (2019): Shareholder lawsuit alleging inadequate cybersecurity controls

**Scoring:**
- PASS: No breach-related securities litigation
- FAIL: Active or settled securities litigation
- UNDETERMINED: Cannot confirm litigation history

**Risk Value:** ____ (0–10)

---

## Section 3: Security Posture and Controls

### Q3.1 — Encryption and Data Protection
**Question:** Was the exposed data encrypted at rest and/or in transit?

**Context:** Encryption significantly reduces breach impact (legal safe harbor in many states, reduces notification burden if encrypted with proper key management).

**Relevant Cases:**
- Yahoo: Password hashes were MD5 (weak) — no encryption on stored user data
- Marriott: Some Starwood databases had no encryption; payment card data encrypted but keys co-located
- Equifax: Data was not encrypted at rest — plaintext SSNs exposed
- Capital One: Data not encrypted at rest — plaintext SSNs, bank account numbers exposed

**Scoring:**
- PASS: All sensitive data encrypted at rest and in transit with proper key management
- FAIL: Plaintext sensitive data exposed due to lack of encryption
- UNDETERMINED: Encryption practices not audit-confirmed

**Risk Value:** ____ (0–10)

---

### Q3.2 — Access Controls and Segmentation
**Question:** Did the breach result from inadequate access controls or network segmentation?

**Context:** Proper access controls (least privilege, MFA, network segmentation) contain blast radius. Many major breaches exploited single points of access with excessive privileges.

**Relevant Cases:**
- Target: HVAC vendor credentials granted access to POS network (no segmentation)
- Marriott: Compromised admin credentials on Starwood property management system
- Equifax: Unpatched Apache Struts CVE on internet-facing portal → access to 40+ databases
- Capital One: SSRF vulnerability exploited — firewall misconfiguration allowed data exfiltration

**Scoring:**
- PASS: Demonstrated least-privilege access, MFA, and network segmentation
- FAIL: Breach exploited weak access controls or lack of segmentation
- UNDETERMINED: Access control architecture not verified

**Risk Value:** ____ (0–10)

---

### Q3.3 — Patch Management
**Question:** Did the breach exploit a known, unpatched vulnerability (CVE)?

**Context:** Exploitation of known, patchable vulnerabilities indicates deficient vulnerability management programs.

**Relevant Cases:**
- Equifax: Apache Struts CVE-2017-5638 — patch available March 2017, breach started May 2017
- Marriott: No specific CVE, but unpatched systems in Starwood environment
- Capital One: ModSecurity WAF misconfiguration, not a missing patch
- SolarWinds (2020): Supply chain compromise — not traditional patch failure

**Scoring:**
- PASS: No breach caused by known unpatched vulnerability
- FAIL: Breach exploited known CVE with available patch not applied
- UNDETERMINED: Cannot verify patch posture at time of breach

**Risk Value:** ____ (0–10)

---

### Q3.4 — Third-Party/Vendor Risk Management
**Question:** Did the breach involve a third-party vendor, supplier, or acquired subsidiary?

**Context:** Third-party risk is a top attack vector. M&A due diligence must assess both target and target's vendors.

**Relevant Cases:**
- Target: HVAC vendor Fazio Mechanical — credentials stolen via phishing, used to access POS
- Marriott: Starwood reservation system — breach of acquired company's infrastructure
- SolarWinds: Nation-state supply chain compromise of Orion platform
- Capital One: AWS cloud infrastructure misconfiguration (shared responsibility gap)

**Scoring:**
- PASS: No breach via third party, or vendor security program validated
- FAIL: Breach originated from third-party compromise
- UNDETERMINED: Third-party security program not assessed

**Risk Value:** ____ (0–10)

---

## Section 4: Incident Response Capability

### Q4.1 — IR Team and Process
**Question:** Does the company have a documented, tested incident response plan with a dedicated IR team?

**Context:** IR maturity directly impacts breach containment time, evidence preservation, and regulatory compliance.

**Relevant Cases:**
- Capital One: Within hours of researcher notification, had CISO, legal, and FBI engaged — good IR execution
- Equifax: Slow containment — 40+ databases exfiltrated over months; IR team struggled with scope
- Uber: No IR — chose concealment over response

**Scoring:**
- PASS: Documented IR plan, dedicated team, tabletop exercises conducted in past 12 months
- FAIL: No IR plan, no dedicated team, or evidence of cover-up vs. response
- UNDETERMINED: IR capability not verified

**Risk Value:** ____ (0–10)

---

### Q4.2 — Remediation Timeline
**Question:** How quickly was the vulnerability closed and normal operations restored?

**Context:** Remediation speed indicates operational security maturity. Fast remediation limits blast radius and data loss.

**Relevant Cases:**
- Capital One: Vulnerability closed within hours of discovery
- Equifax: Vulnerability patched 2 days after discovery, but 40+ databases had already been exfiltrated over months
- Marriott: Starwood systems isolated; full remediation took months due to integration complexity

**Scoring:**
- PASS: Vulnerability closed within 24 hours, containment within 48 hours
- FAIL: Remediation took weeks or months; data exfiltration continued
- UNDETERMINED: Remediation timeline not verifiable

**Risk Value:** ____ (0–10)

---

### Q4.3 — Post-Incident Improvements
**Question:** Did the company implement substantive security improvements after the breach?

**Context:** Post-incident improvements demonstrate learning and reduced likelihood of recurrence. Absence of improvements is a red flag.

**Relevant Cases:**
- Capital One: Significantly enhanced cloud security posture, added encryption at rest, improved WAF
- Equifax: CISO retired, $1.5B+ cybersecurity investment program, new CRO role created
- Yahoo: Security improvements limited prior to Verizon acquisition; post-acquisition significantly enhanced
- Uber: DPO hired, bug bounty program expanded, new security team structure

**Scoring:**
- PASS: Demonstrable security improvements post-incident with measurable outcomes
- FAIL: No meaningful improvements, or same class of breach recurred
- UNDETERMINED: Post-incident changes not documented

**Risk Value:** ____ (0–10)

---

## Section 5: M&A-Specific Considerations

### Q5.1 — Integration Security
**Question:** If the target has completed previous acquisitions, were those integrations secure?

**Context:** Poor integration security creates blind spots (Marriott/Starwood). Acquirers should assess target's track record with prior acquisitions.

**Relevant Cases:**
- Marriott: Starwood systems never fully integrated — ran separate reservation platform → breach vector
- Yahoo: Verizon demanded $350M discount after breach disclosure; integration complicated by undisclosed breach subs
- Microsoft/Nokia: Nokia device services integration created new attack surface

**Scoring:**
- PASS: Prior acquisitions integrated with clean security outcomes
- FAIL: Prior acquisition created material security incident
- UNDETERMINED: Prior acquisition security outcomes unverified

**Risk Value:** ____ (0–10)

---

### Q5.2 — Breach Warranty and Reps
**Question:** Does the target have sufficient cyber insurance and indemnification coverage for pre-existing breaches?

**Context:** Breach disclosure during diligence affects acquisition terms. Insurance coverage and escrow provisions mitigate post-acquisition liability.

**Relevant Cases:**
- Verizon/Yahoo: $350M purchase price reduction, retained Yahoo liability for government investigations and litigation
- Marriott: Insurance coverage for $52M EU fines, but self-insured for most costs
- Equifax: $1.5B+ in total breach costs; D&O insurance partially covered securities litigation

**Scoring:**
- PASS: Adequate cyber insurance ($10M+ coverage), clean reps on known breaches
- FAIL: Inadequate or lapsed cyber insurance; known breach concealed in diligence
- UNDETERMINED: Insurance coverage and breach reps not reviewed

**Risk Value:** ____ (0–10)

---

### Q5.3 — Data Residency and Cross-Border Exposure
**Question:** Does the target store or process data across jurisdictions, and were breaches multinational?

**Context:** Cross-border data incidents trigger multiple regulatory regimes (GDPR, PIPL, LGPD, CCPA), multiplying liability.

**Relevant Cases:**
- Marriott: Global operations — GDPR (UK ICO £18.4M), US multi-state, multiple EU DPA actions
- Yahoo: Global user base — investigated by SEC, FTC, multiple international DPAs
- Equifax: US, UK (115,000 UK citizens affected — ICO investigation), international regulators

**Scoring:**
- PASS: Data residency compliant, no cross-border breach exposure
- FAIL: Breach involved multiple jurisdictions with active regulatory actions
- UNDETERMINED: Data flow map not obtained

**Risk Value:** ____ (0–10)

---

## Section 6: Culture and Governance

### Q6.1 — Board-Level Security Oversight
**Question:** Does the board have cybersecurity expertise or a dedicated risk committee?

**Context:** Board-level security oversight is correlated with better breach outcomes. SEC rules (2024) require disclosure of board cybersecurity expertise.

**Relevant Cases:**
- Capital One: Strong board oversight post-2019 breach; CISOs report directly to board risk committee
- Equifax: No board-level cybersecurity expertise at time of breach; CISO retired post-breach
- Yahoo: Securities litigation alleged board failed to oversee security risk

**Scoring:**
- PASS: Board has dedicated cybersecurity committee or member with relevant expertise
- FAIL: No board-level security oversight; security governance is absent
- UNDETERMINED: Board composition and committee charters not reviewed

**Risk Value:** ____ (0–10)

---

### Q6.2 — Security Organization Structure
**Question:** Does the CISO/security leader report independently (not through IT/CIO)?

**Context:** Reporting structure independence is a strong governance indicator. CISOs reporting through CIOs face conflicts between security and operational priorities.

**Relevant Cases:**
- Equifax: Security reported under CSO who also owned physical security and IT — no independent security leadership
- Capital One: CISO reported to Board risk committee, independent of IT leadership
- Yahoo: Security team under IT operations — funding and resourcing structurally deficient

**Scoring:**
- PASS: CISO or equivalent reports to CEO or board risk committee
- FAIL: Security reports through IT/CIO or has no independent budget
- UNDETERMINED: Org structure not verified

**Risk Value:** ____ (0–10)

---

## Scoring Summary

| Section | Max Risk | Score |
|---------|----------|-------|
| 1. Known Breach History | 40 | ______ |
| 2. Disclosure Patterns | 30 | ______ |
| 3. Security Posture & Controls | 40 | ______ |
| 4. Incident Response Capability | 30 | ______ |
| 5. M&A-Specific Considerations | 30 | ______ |
| 6. Culture and Governance | 20 | ______ |
| **Total** | **190** | **______** |

**Risk Rating:**
- **Low Risk (0–29):** Target has strong breach/incident posture
- **Medium Risk (30–79):** Target has moderate exposure requiring indemnification
- **High Risk (80+):** Target has material breach/incident exposure — reconsider terms or walk

---

## Reference Cases (for assessor context)

1. **Yahoo (2013–2016):** 3B accounts, all accounts compromised. Delayed disclosure 3 years. $35M SEC fine, $80M class action. Acquired by Verizon with $350M price reduction. Disclosure pattern: systematic concealment.

2. **Marriott/Starwood (2014–2018):** 500M guests. Passport numbers, payment cards. Acquired Starwood 2016; breach of Starwood systems traced to 2014. £18.4M ICO fine, $52M EU fines. Integration security failure.

3. **Uber (2016):** 57M users. Hackers accessed AWS, found credentials in plaintext. Paid $100k ransom. Concealed for 1+ year. $148M settlement. CISO convicted of obstruction.

4. **Equifax (2017):** 147M. Plaintext SSNs, credit cards. Exploited known unpatched CVE. $700M+ total penalties. CEO sold shares pre-disclosure. Post-breach: $1.5B+ security investment.

5. **Target (2013):** 70M payment cards, 70M customer records. HVAC vendor compromise → POS network. $18.5M state AG settlement. Catalyst for modern vendor risk management.

6. **Capital One (2019):** 106M — SSNs, bank accounts. SSRF in cloud WAF. No encryption at rest. Fast IR, vulnerability closed same day. $190M settlement. Post-breach: encryption-at-rest program.

7. **SolarWinds (2020):** Supply chain compromise of Orion platform. 18,000+ customers affected. Nation-state attribution. Catalyst for SBOM (software bill of materials) mandates.

8. **Colonial Pipeline (2021):** Ransomware attack. Operational impact: fuel pipeline shut down 5 days. Paid $4.4M ransom (partially recovered). Catalyst for CISA mandatory reporting rules.

9. **Facebook/Cambridge Analytica (2018):** 87M users. Data harvested via third-party app API. Not a technical breach — authorized API misuse. £500K ICO fine (pre-GDPR max), $5B FTC fine.

10. **Twitter (2020):** Spear-phishing of employees → 130 celebrity accounts compromised. Bitcoin scam. Illustrates social engineering risk despite technical controls.

---

## Change Log

| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-08-21 | v1.0 | CSO | Initial draft for CEO review and QA verification |
