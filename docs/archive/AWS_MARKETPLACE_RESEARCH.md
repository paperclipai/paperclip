# AWS Marketplace Research — SELARIX by QSL Security Ops

**Date:** March 31, 2026
**Product:** SELARIX — Post-Quantum Cryptography (PQC) Migration Tool
**Company:** QSL Security Ops
**Category:** Healthcare Cybersecurity SaaS

---

## Path A: AWS Marketplace SaaS Listing

### Technical Requirements

- **SaaS Integration:** Product must be deployed as a SaaS application hosted on AWS infrastructure. You must implement the AWS Marketplace Metering Service API or the AWS Marketplace Contracts API to handle usage tracking and entitlements.
- **AWS Account:** A registered AWS seller account is required. You onboard through the AWS Marketplace Management Portal (AMMP).
- **Billing Integration:** All billing flows through AWS. You integrate with one of three pricing models: subscription (flat monthly/annual), contract (prepaid terms), or usage-based (metered per API call, user, scan, etc.). AWS handles invoicing and collections on your behalf. Buyers pay through their existing AWS bill — this is the single biggest advantage for enterprise procurement.
- **Architecture:** The product must run on AWS (EC2, ECS, Lambda, etc.). You provide a SaaS fulfillment URL that handles subscriber registration when a buyer clicks "Subscribe" in the Marketplace.
- **Product Page Assets:** You supply a logo (120x120 and 220x220), short and long descriptions, highlight bullets, pricing details, support information, EULA or standard contract terms, and up to three product screenshots.

### Legal Requirements

- **EULA or AWS Standard Contract for AWS Marketplace (SCMP):** You can use the AWS-provided standard contract (preferred by many buyers, especially government/healthcare) or upload your own EULA.
- **Tax and Banking Information:** You must complete tax identity verification and provide valid banking details for disbursement.
- **Data Processing Addendum:** For healthcare products handling PHI, you should have a data processing agreement in place.

### Approval Timeline

- **Initial Seller Registration:** 2–4 weeks for account verification and onboarding.
- **Product Listing Review:** AWS reviews the listing for completeness, security, and compliance. This typically takes 2–4 weeks for a straightforward SaaS listing. Complex listings or those requiring additional security review can take 4–8 weeks.
- **Total Estimated Time:** 4–8 weeks from submission to live listing, assuming integration work is already complete.

### What Healthcare Buyers See

Buyers find SELARIX through keyword search (e.g., "post-quantum cryptography," "PQC," "healthcare encryption"), category browsing under Security, or via curated collections. The listing page shows the product description, pricing, vendor information, support details, customer reviews, and any compliance badges. Healthcare buyers can filter by compliance program (HIPAA, HITRUST, FedRAMP). Purchases flow directly through the AWS bill, which simplifies procurement enormously — many hospital systems and health plans have pre-approved AWS spending.

### Revenue Split / Fees

- **Standard fee:** AWS retains **3% of gross revenue** for listings that go through the standard channel.
- **AWS-sourced deals:** If AWS's sales team or Partner Network sources the deal, the fee increases to **8–15%** depending on the arrangement.
- **Channel partner private offers:** If a consulting partner co-sells, you negotiate the partner margin separately (typically 10–20%), plus the AWS base fee.
- **Disbursement:** Monthly, net 30–60 days after buyer payment.

---

## Path B: AWS Bedrock Agent Listing

### Current State of the Bedrock Marketplace

As of early 2026, AWS Bedrock supports a curated selection of foundation models (Anthropic Claude, Meta Llama, Cohere, AI21, Stability AI, Mistral, etc.) and allows customers to build agents and knowledge bases on top of those models. However, **AWS does not currently operate a general-purpose "Bedrock Agent Marketplace"** where third-party vendors can list and sell standalone AI agents in the same way SaaS products are listed on AWS Marketplace.

What does exist:

- **Bedrock Model Marketplace:** Foundation model providers can list their models. This requires a direct partnership with AWS and is not open to general SaaS vendors.
- **Bedrock Agents (customer-built):** Enterprises build their own agents using Bedrock's agent framework, connecting to their own data sources and action groups.
- **AWS Marketplace AI/ML Category:** You can list an AI-powered SaaS product (which uses Bedrock under the hood) as a standard AWS Marketplace SaaS listing. This is effectively Path A with an AI branding angle.

### What This Means for SELARIX

There is no separate "Bedrock Agent listing" path available today. If SELARIX has an AI agent component (e.g., an LLM-powered PQC assessment agent, a conversational compliance assistant), the path to market is still **Path A — list as a SaaS product on AWS Marketplace** that happens to use Bedrock internally. You would highlight the AI/ML capabilities in your product description and categorize under both Security and AI/ML.

### If a Bedrock Agent Marketplace Opens

AWS has signaled interest in expanding the Bedrock ecosystem. If a dedicated agent marketplace launches, expect requirements similar to model providers: rigorous security review, responsible AI documentation, performance benchmarks, and potentially AWS-managed inference infrastructure. Timeline and fees are speculative but would likely mirror or exceed standard Marketplace fees given the added infrastructure cost.

---

## Healthcare-Specific Requirements (Both Paths)

| Requirement | Details |
|---|---|
| **HIPAA BAA** | If SELARIX processes, stores, or transmits PHI, you must sign a Business Associate Agreement with AWS. AWS offers a standard BAA for eligible services. Your product listing should state HIPAA eligibility clearly. |
| **HIPAA Eligible Services** | Ensure SELARIX only uses AWS services covered under the AWS BAA (S3, EC2, RDS, Lambda, KMS, etc. are covered; not all services are). |
| **Compliance Badges** | AWS Marketplace supports compliance program filtering. You can display HIPAA, HITRUST, SOC 2, FedRAMP badges if you hold the relevant certifications. These badges are **self-attested** but AWS may request documentation. |
| **HITRUST Certification** | Not required to list, but strongly recommended for healthcare sales. Many health systems mandate HITRUST CSF certification for vendors. |
| **SOC 2 Type II** | Expected by enterprise healthcare buyers. Not required for listing but significantly impacts buyer confidence. |
| **FedRAMP** | Required only if targeting federal healthcare (VA, DoD health, CMS). Adds 6–18 months and significant cost. |
| **Encryption Standards** | Particularly relevant for SELARIX — document which NIST PQC standards you implement (ML-KEM, ML-DSA, SLH-DSA). AWS KMS itself has begun integrating PQC, which is a natural integration story. |

---

## Minimum Viable Listing: Can You List with a Landing Page + Waitlist?

**Short answer: No, not as a standard public listing.** AWS Marketplace requires a functional product that buyers can subscribe to and use. A landing page with a waitlist does not meet the integration requirements (Metering API, fulfillment URL, working entitlement flow).

**However, there are workarounds:**

- **Private Offers:** You can create private offers for specific buyers before your product is fully scaled. This lets you onboard early design partners through AWS billing without a polished public listing.
- **"Contact Us" Pricing:** You can list with a "Contact Us" pricing model instead of self-service subscribe. This means buyers request a demo/consultation rather than immediately provisioning. This is the closest to a "waitlist" approach and is commonly used for enterprise security products.
- **Minimal SaaS Scope:** Your initial listing can offer a limited feature set — for example, a PQC readiness assessment scan only — and expand over time. There is no minimum revenue or usage threshold.

---

## Comparison Table

| Factor | Path A: SaaS Listing | Path B: Bedrock Agent Listing |
|---|---|---|
| **Availability** | Available now | Not available as a distinct path |
| **Time to List** | 4–8 weeks | N/A (use Path A) |
| **AWS Fee** | 3% standard | N/A |
| **Billing Integration** | AWS Metering/Contracts API | N/A |
| **Healthcare Compliance** | HIPAA badges, BAA support | N/A |
| **Minimum Product** | Working SaaS + API integration | N/A |
| **"Contact Us" Option** | Yes | N/A |
| **Private Offers** | Yes | N/A |
| **Buyer Discovery** | Search, category, compliance filters | N/A |
| **AI Branding** | Can list under AI/ML category | N/A |

---

## Recommended Path

**Path A: AWS Marketplace SaaS Listing** is the only viable path today. There is no separate Bedrock Agent marketplace to target.

### Suggested Approach for SELARIX

1. **Register as an AWS Marketplace Seller** — Begin the onboarding process immediately. This runs in parallel with development.
2. **Implement "Contact Us" Pricing First** — This lets you list without full self-service provisioning. Enterprise healthcare buyers expect a sales conversation for security tooling anyway.
3. **Integrate the Metering API** — Even with Contact Us pricing, implementing basic metering demonstrates marketplace maturity and enables usage-based pricing later.
4. **Pursue SOC 2 and HIPAA Compliance Badges** — Self-attest to HIPAA eligibility on the listing. Begin SOC 2 Type II audit if not already underway. These badges materially affect healthcare buyer conversion.
5. **Use Private Offers for Early Customers** — Onboard initial hospital systems or health plans through private offers to build case studies before scaling the public listing.
6. **Brand the AI Capabilities** — If SELARIX uses LLM-powered analysis (Bedrock or otherwise), highlight this in the listing under both Security and AI/ML categories. This increases discoverability.
7. **Target HITRUST Within 12 Months** — Begin HITRUST CSF readiness assessment. This unlocks the largest healthcare enterprise buyers.

### Timeline Estimate

| Milestone | Timeframe |
|---|---|
| Seller account registration | Weeks 1–3 |
| Listing assets and integration | Weeks 2–6 |
| AWS review and approval | Weeks 5–8 |
| First private offer to design partner | Weeks 8–10 |
| Public listing live | Weeks 8–12 |

---

*Research compiled March 31, 2026. AWS Marketplace terms and features are subject to change. Verify current fees and requirements at aws.amazon.com/marketplace/management.*
