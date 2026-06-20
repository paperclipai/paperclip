# PQC Healthcare Guide Drafts — Spun from $197 Playbook
# Created: 2026-03-31
# Source: PQC Healthcare Playbook (Gumroad, $197)

---

## GUIDE 1 — "PQC Quick-Start for Hospital CISOs"
**Target:** Healthcare CISOs with 30 minutes to read
**Price:** $47
**Format:** 5 chapters, ~3,000 words
**Positioning:** "The 30-minute briefing your board expects you've already read"

### Full Outline

**Chapter 1 — The Quantum Clock Is Ticking (600 words)**
- Harvest-now-decrypt-later: why PHI encrypted today is vulnerable tomorrow
- NIST PQC standards finalized (FIPS 203/204/205) — the compliance window is open
- Healthcare is target #1: long data retention + high ransom value
- Key stat: average healthcare breach cost $10.93M (IBM 2025) — PQC failure multiplies this
- What "cryptographically relevant quantum computer" means in plain English

**Chapter 2 — Your Exposure in 15 Minutes (500 words)**
- Quick crypto inventory checklist: TLS, VPN, SFTP, database encryption, API auth
- The 3 zones: data at rest, data in transit, data in signing/authentication
- Which algorithms you're running today (RSA-2048, ECDSA, AES-GCM) and which break
- AES-256 survives (Grover's halves key strength) — stop panicking about symmetric
- 5-question self-assessment: "How exposed is my hospital?"

**Chapter 3 — The Migration Playbook (800 words)**
- Phase 1: Inventory (weeks 1-4) — catalog every cryptographic dependency
- Phase 2: Prioritize (weeks 5-8) — rank by data sensitivity × algorithm vulnerability
- Phase 3: Hybrid deployment (months 3-6) — ML-KEM + classical in parallel
- Phase 4: Full cutover (months 6-12) — deprecate classical-only paths
- Vendor pressure template: "Dear EHR vendor, what is your PQC migration timeline?"
- Budget reality: most migration is config changes, not rip-and-replace

**Chapter 4 — Compliance and Regulatory Landscape (600 words)**
- HIPAA doesn't name algorithms — but "reasonable safeguards" will evolve
- HHS OCR enforcement trends: encryption is already a safe harbor
- NIST SP 800-131A Rev 3 implications for healthcare
- State laws: NY SHIELD Act, California CCPA/CPRA — crypto adequacy standards
- Insurance: cyber liability carriers starting to ask about PQC readiness
- The board question: "Are we compliant if quantum breaks our encryption tomorrow?"

**Chapter 5 — Your 90-Day Action Plan (500 words)**
- Week 1: Run crypto inventory (tools: CrawDaddy scan, IBM Quantum Safe Explorer)
- Week 2: Brief the board (use Chapter 1 talking points)
- Week 3-4: Send vendor questionnaire to top 5 EHR/infrastructure vendors
- Month 2: Pilot hybrid TLS on one non-critical system
- Month 3: Document PQC roadmap, add to annual security plan
- Template: 1-page PQC status report for board meetings
- Resource list: NIST, CISA, HHS guidance documents

---

## GUIDE 2 — "NIST PQC Migration Checklist for EHR Vendors"
**Target:** EHR software security teams
**Price:** $29
**Format:** 20-item actionable checklist with pass/fail criteria
**Positioning:** "The compliance checklist your hospital customers will start demanding"

### Full Checklist

#### Discovery & Inventory
- [ ] **1. Catalog all cryptographic libraries** — List every crypto library in your stack (OpenSSL, BoringSSL, .NET Crypto, Java JCE). Record version numbers. PQC support requires OpenSSL 3.2+, BoringSSL with Kyber, or equivalent.
- [ ] **2. Map certificate chains** — Document every X.509 certificate: CA roots, intermediates, leaf certs. Identify which use RSA vs ECDSA. Flag any hardcoded certificate expectations in code.
- [ ] **3. Inventory key exchange protocols** — List every TLS handshake, SSH connection, VPN tunnel, and API auth flow. Note which use ECDH, RSA key exchange, or static keys.
- [ ] **4. Identify data-at-rest encryption** — Catalog database encryption (TDE, column-level, application-layer). Note algorithm and key sizes. AES-256 is quantum-safe; RSA-wrapped keys are not.
- [ ] **5. Audit HL7/FHIR transport security** — Check TLS versions on all HL7v2 MLLP, FHIR REST, and SMART-on-FHIR endpoints. Document cipher suites in use.

#### Risk Assessment
- [ ] **6. Classify data by retention period** — PHI retained 6+ years faces highest harvest-now-decrypt-later risk. Prioritize long-retention data stores for PQC migration.
- [ ] **7. Score algorithm vulnerability** — RSA-2048, ECDSA-256, ECDH = BROKEN by quantum. AES-128 = weakened. AES-256, SHA-256+ = safe. Score each system red/yellow/green.
- [ ] **8. Assess third-party integrations** — For every external API (labs, pharmacy, clearinghouse, HIE), determine their PQC readiness. You cannot migrate what your partners cannot accept.
- [ ] **9. Evaluate HSM/KMS compatibility** — Check if your hardware security modules and key management systems support ML-KEM (FIPS 203) and ML-DSA (FIPS 204). Many HSMs need firmware updates.
- [ ] **10. Review code signing pipeline** — If you sign releases with RSA or ECDSA, quantum breaks code authenticity. Plan migration to ML-DSA or SLH-DSA (FIPS 205).

#### Implementation
- [ ] **11. Enable hybrid TLS (ML-KEM + X25519)** — Deploy hybrid key exchange on staging. Chrome/Edge already support X25519Kyber768. Test with major browsers and EHR thick clients.
- [ ] **12. Update certificate issuance** — Work with your CA to plan hybrid or pure PQC certificate issuance. DigiCert and Let's Encrypt have PQC beta programs.
- [ ] **13. Migrate key wrapping** — Replace RSA-OAEP key wrapping with ML-KEM encapsulation for database encryption keys and session key distribution.
- [ ] **14. Update FHIR/SMART auth tokens** — If using JWT with RS256/ES256, plan migration to ML-DSA signed tokens. Test with reference FHIR servers.
- [ ] **15. Patch HL7v2 MLLP connections** — Many HL7v2 interfaces still use TLS 1.0/1.1. Upgrade to TLS 1.3 with hybrid PQC cipher suites simultaneously.

#### Validation & Compliance
- [ ] **16. Run PQC interoperability tests** — Test hybrid TLS with top 10 hospital network configurations. Document any handshake failures, certificate rejection, or performance degradation.
- [ ] **17. Measure performance impact** — ML-KEM adds ~1KB to TLS handshake, ML-DSA signatures are larger. Benchmark latency on real EHR workflows. Document: login, patient lookup, order entry, results retrieval.
- [ ] **18. Update SOC 2 / HITRUST controls** — Add PQC migration status to your security control framework. Map to HITRUST CSF v11 controls and SOC 2 CC6.1 (encryption).
- [ ] **19. Create customer-facing PQC statement** — Draft a public statement: "Our PQC migration timeline, what customers need to do, and our commitment." Hospital CISOs will ask for this.
- [ ] **20. Establish crypto agility architecture** — Design your system so algorithms can be swapped without code changes. Use configuration-driven crypto selection. This is the single most important long-term investment.

---

## GUIDE 3 — "Quantum Threat Briefing for Healthcare Boards"
**Target:** Non-technical board members, CXOs
**Price:** $97
**Format:** 8-page executive brief (designed for print/PDF)
**Positioning:** "The board-ready briefing your CISO wishes they had time to write"

### Full Outline

**Page 1 — Executive Summary**
- One-paragraph threat summary: quantum computers will break current encryption within 5-10 years
- PHI is the #1 target: long shelf life, high value, regulatory exposure
- The window to act is NOW — migration takes 2-3 years, standards are final
- Bottom line: this is a fiduciary risk, not just a technology risk
- Call to action: approve PQC readiness assessment by Q3 2026

**Page 2 — What Is the Quantum Threat? (Plain English)**
- Analogy: "Imagine every lock in the hospital can be picked by a new kind of lockpick — but you have time to change the locks before the lockpick is mass-produced"
- Current encryption = mathematical problems computers can't solve fast enough
- Quantum computers solve these specific problems exponentially faster
- NOT science fiction: Google, IBM, Microsoft investing $10B+ combined
- Timeline consensus: 2030-2035 for cryptographically relevant quantum
- "Harvest now, decrypt later": adversaries collecting encrypted data TODAY to decrypt with future quantum computers

**Page 3 — Why Healthcare Is Uniquely Exposed**
- PHI retention requirements: 6 years minimum (HIPAA), often 20+ years
- Data stolen today in encrypted form can be decrypted in 5-10 years
- Average healthcare breach cost: $10.93M (highest of any industry, 14 consecutive years)
- Nation-state interest: Chinese APT groups specifically target US healthcare
- Ransomware evolution: quantum-enabled attackers won't just lock data — they'll prove they can read it
- Regulatory trend: "reasonable safeguards" will include PQC within 2-3 years

**Page 4 — The Business Risk (Numbers That Matter)**
- Cost of a breach today: $10.93M average, $50M+ for large systems
- Cost of PQC migration: $200K-$2M depending on size (10-20x less than a breach)
- Insurance impact: carriers beginning to ask about quantum readiness in applications
- Competitive advantage: "PQC-ready" is becoming a procurement differentiator
- M&A risk: acquiring a system with no PQC plan = inheriting quantum debt
- Regulatory fines: HHS OCR penalties + state AG actions if "reasonable" standard evolves

**Page 5 — What the Government Is Doing**
- NIST finalized PQC standards (FIPS 203, 204, 205) — August 2024
- NSA CNSA 2.0: federal systems must begin migrating by 2025, complete by 2033
- Executive Order 14028 (Improving Cybersecurity): crypto agility mandate
- CISA guidance: healthcare listed as critical infrastructure priority
- HHS 405(d) Health Industry Cybersecurity Practices: PQC alignment coming
- Bottom line: the government has decided — standards exist, timelines are set

**Page 6 — What Our Organization Needs to Do**
- Step 1: Crypto inventory (know what we have) — 4-6 weeks
- Step 2: Risk assessment (know what's vulnerable) — 2-4 weeks
- Step 3: Vendor engagement (push our suppliers) — ongoing
- Step 4: Pilot hybrid deployment (test the new standards) — 3-6 months
- Step 5: Full migration roadmap — 12-24 months to complete
- Resource requirement: 0.5-1 FTE security engineer + vendor coordination
- Budget ask: $150K-$500K over 24 months (depending on system size)

**Page 7 — Peer Benchmarking**
- Where top-20 health systems stand on PQC (survey data / industry reports)
- Early movers: Mayo Clinic, Kaiser, Cleveland Clinic crypto agility initiatives
- Laggards: most community hospitals haven't started
- Analyst view: Gartner, Forrester, KLAS on healthcare PQC readiness
- Comparison: financial services sector is 18-24 months ahead of healthcare
- Opportunity: being early = competitive differentiation with patients and partners

**Page 8 — Board Resolution Template & Next Steps**
- Sample board resolution: "RESOLVED, that management shall complete a post-quantum cryptography readiness assessment by [date] and present a migration roadmap to the Board by [date]"
- Recommended timeline: assessment in Q3, roadmap in Q4, first pilot in Q1 2027
- Metrics for board reporting: % of systems inventoried, % hybrid-ready, vendor compliance rate
- Quarterly update template (1-page format)
- Contact: QSL Security Ops — quantumshieldlabs.dev
