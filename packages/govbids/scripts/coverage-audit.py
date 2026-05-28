#!/usr/bin/env python3
"""Cross-reference team-distributed RFP titles against our scored pipeline data.

For each manual RFP the teams worked on, find the closest fuzzy match in our scored
data and bucket the result so we know WHY the pipeline missed it.
"""
import json
import re
import sys
from pathlib import Path
from difflib import SequenceMatcher
from collections import Counter

DATA = Path("/Users/bb/conductor/workspaces/paperclip/delhi/packages/govbids/data/daily")

# Team distributions parsed from the Slack export.
# Date is the post date; the RFP itself was usually current or recently posted.
TEAM_RFPS = {
    "2026-05-12": [
        "Rapid7 Managed Threat Complete Advanced Managed Detection and Response Services",
        "AI Enabled MTSS Platform",
        "MICROSOFT UNIFIED SUPPORT SERVICES",
        "Data Analytics Systems",
        "as needed computer services rebid",
        "Managed IT and Cyber Security Services",
        "NETWORK INFRASTRUCTURE SUPPORT RFP 26107",
        "Technology Consulting Services Project Alpha",
        "Enterprise Resource Planning ERP Assessment Consulting Services",
        "Penetration Testing Services",
        "Data Dashboard and Analytic Service",
        "IT Support Services",
        "Enterprise AI Platforms Services and Integrated Delivery",
        "Test Analysts",
        "Managed Network Services",
        "Live Language Interpreting Platform Utilizing Artificial Intelligence",
        "Professional services to perform implementation of a Microsoft 365 based intranet and collaboration platform SharePoint",
        "Information Technology IT Services",
        "2026 Information Technology Services",
        "Managed Security Operations Center MSOC Service Provider",
        "RFP Information Technology Professional Services",
        "Master Data Management and Analytics Solution",
        "GENERAL DATA COLLECTION AND ANALYSIS SERVICES",
        "Data Analytics Platform",
        "IT Asset Disposition ITAD Services",
        "AMANDA Case Management System On Premise to Cloud Migration",
        "DHIS2 and Power BI Consultant",
        "26 2661 MICROSOFT OFFICE COMPUTER TRAININGS Rebid D",
        "IT Security Infrastructure and Governance Improvement Program",
        "NETWORK INFRASTRUCTURE SUPPORT",
        "RFP 28 2026 AI Powered Operational Platform for Material Recovery Facility MRF",
        "AI Powered Predictive Analytics and Clinical Decision Support Platform",
        "Software Training Services",
        "ASSET MANAGEMENT PLAN PLATFORM AND PLANS FOR THE STATE OF WYOMING",
        "Implementation of Salesforce Platform for NYS Fair",
        "IT Support Services",
        "Enterprise Resource Planning Replacement",
    ],
    "2026-05-13": [
        "Cybersecurity Penetration and Vulnerability Testing Services rebid",
        "Consultant to Design Develop and Implement Ecosystem Dashboard",
        "Information Technology Services",
        "IT Management and Related Services",
        "Enterprise Artificial Intelligence Platforms Services and Integrated Delivery",
        "Infrastructure Asset Management Program Advancement and CMMS Implementation",
        "Network Security Services",
        "RFQ for Technical Consultant and Web Development Services",
        "Technology Solutions Cybersecurity Hardware Software and Data Analytics Technology Systems",
        "SHAREPOINT REDESIGN SERVICES",
        "Project Leader Services ERP Project",
        "Application Manager Enterprise Job Scheduling Software",
        "PostgreSQL Database Support Services",
        "Assessment Management Data Analytics and Intervention Support System",
        "Enterprise Tech and AI Strategic Roadmap",
        "Information Technology Vendor Managed Services and Solution",
    ],
    "2026-05-14": [
        "Broadcom VMWare Software",
        "AI Delivery Lead CMAS RFO",
        "Bruno API Testing Tool",
        "SaaS Migration and Implementation of DHSEMS WebEOC Database to Juvare Hosted Environment",
        "Fairfax Software Maintenance and Related Services",
        "REPLACEMENT OF eGIS WEB APPLICATION INTEGRATED REPORT GENERATION PLATFORM",
        "Information Technology Support Services",
        "Managed IT and Cyber Security Services",
        "Quality Control Audit Software",
        "SCADA Master Plan",
        "Scheduling Time and Attendance Software Solution",
        "ERP and Utility Billing System Procurement Including Implementation Services",
        "Stc For It Professional Services",
        "CLOUD HOSTED CYBER ASSET ATTACK SURFACE MANAGEMENT CAASM",
        "Student Virtual Desktop Infrastructure",
        "Telecommunications Infrastructure Management System",
        "Municipal Fiber Network Operations Center NOC Support Services",
        "SCHEDULING AND TIME AND ATTENDANCE SOFTWARE SOLUTION",
        "ITS for Security Consulting Services",
        "Mass Notification Solution",
        "Microsoft Dynamics 365 Business Central Software Licensing Implementation and Support Services",
    ],
    "2026-05-19": [
        "Test Environment Configuration Services",
        "Student Information System SIS Modernization",
        "Microsoft Support Services",
        "Drupal Website Hosting Services",
        "IT Director Services",
        "Salesforce CRM Software Maintenance",
        "Secure Information Management for AI",
        "Oracle Premium Support Infrastructure Renewal",
        "IT Network and Security Consultant",
        "IT Network Monitoring Support and Maintenance Services for School Facilities",
        "Security Information and Event Management System",
        "Data Engineering Services",
        "GMCB Health Data Infrastructure Transformation",
        "Managed Service Provider",
        "Enterprise Resource Planning ERP Solution",
        "Remote Database Administration DBA Services",
        "OneLogin MultiFactor Authentication MFA SaaS Integration for Workday Based State Personnel System",
        "INFORMATION TECHNOLOGY NEEDS ASSESSMENT AND STRATEGIC PLAN",
        "ARTIFICIAL INTELLIGENCE AI GOVERNANCE AND POLICY COMPLIANCE DASHBOARD",
        "Technology AI Integration for Legal Aid Intake System",
    ],
    "2026-05-20": [
        "AI Model LLM Support",
        "CareWare 6 Maintenance and Hosting",
        "Venue and Event Management Software",
        "Lake Tahoe Info Software Consultant",
        "Campus Wide Enterprise Artificial Intelligence AI Platform",
        "Professional Licensing and Registration System Modernization",
        "ELECTRONIC SAFETY MANAGEMENT SYSTEM SUBSCRIPTION",
        "Temporary Staffing Services As Needed",
        "Cisco Meraki Software 5 Year Enterprise Agreement",
        "CLOUD SECURITY SOFTWARE",
        "FY27 On Call SCADA Services",
        "Systems Integration Software Solution and Services",
        "2026 1185 Enterprise Education Cloud Implementation",
        "Information Technology Service Provider",
        "Integrated Service Management Platform",
        "Strategic Planning and Software",
        "Workday Augmentation Resourcing",
        "Enterprise AI Platform Procurement",
        "Comprehensive cloud based educational software platform and related professional services",
        "LED Salesforce Implementation for Grants Incentives and Operations Management",
        "Municipal Integrated ERP Financial Accounting Software Suite",
    ],
    "2026-05-21": [
        "CYBERSECURITY INFO SHARING",
        "Transportation Management Software",
        "Annual Contract for HRIS Solution",
        "Managed Security Service Provider",
        "Procore Project Management Software",
        "OnSpring Consultant Support and Services Provider",
        "Paratransit Software Management System",
        "OnCall Web Developer",
        "Artificial Intelligence AI Strategic Roadmap and Governance Framework Consultant",
        "CampusESP Parent Communication Platform and Content",
        "ManageEngine ServiceDesk Plus On Demand",
        "Phire Software License and Related Services",
        "Cloud Based Artificial Intelligence Platform for City of Southlake",
        "Enterprise Resource Planning System RFP",
        "AMDT Automated Inventory and Change Management Software",
        "Salt Lake City Corporation Professional Services SLCI26063 Cyber Security Training",
        "Syspro ERP Software",
        "ENTERPRISE ASSET MANAGEMENT PLATFORM",
        "Wyoming 511 Mobile Application Modernization For Both Android And Ios Platforms",
        "PreK 12 AI Solutions",
    ],
    "2026-05-22": [
        "Enterprise Policy and Document Management System",
        "ServiceNow FY27",
        "IFB Recorded Future Master Contract",
        "Digital Experience Cloud Platform",
        "Event Management Software",
        "HUDL Cloud Based Athletic Performance Platform Integration",
        "Network Migration",
        "IT Security Assessments and Incident Response Services",
        "Instructional Technology Library Services and Assessment Analytics",
        "RFQ for Software Development Partner for Gamified Learning Tool",
        "Bridge Management System",
        "Administrative Investigations and Professional Standards Law Enforcement Software",
        "DES FY27 Data Analytics",
        "Barracuda Support and Maintenance",
        "PROFESSIONAL SERVICES TRIMBLE UNITY MAINTAIN IMPLEMENTATION PROJECT S 497",
        "Digital Portfolio Curation Platform",
        "IT Supplemental Staffing Open Enrollment 2026",
        "Risk Quality and Compliance Software Solution",
        "Accounts Payable Automation Software",
        "ADOBE CREATIVE CLOUD MAINTENANCE AND SUPPORT",
        "Risk Management Information System",
        "MDILog Record Management Software for DSHS",
        "Mobile Data Analytics Services",
        "CRM DATABASE FOR ECONOMIC WORKFORCE DEVELOPMENT",
        "ESRI Maintenance Renewal",
        "Enterprise Resource Planning Consulting Service",
        "ArcGIS Enterprise Cloud Minimum Viable Product MVP",
    ],
    "2026-05-27": [
        "managed Cybersecurity services",
        "VMware Licensing",
        "Cybersecurity",
        "TNH078 2026 Barracuda Support and Maintenance",
        "Oracle Fusion Data Intelligence Implementation Services",
        "Kentico xPerience Upgrade",
        "Enterprise Resource Planning ERP Implementation and Support Services",
        "SIEM and SOC Support Services",
        "Recreation Management System",
        "Audit and Data Analytics Software",
        "Erp Implementation Consultant",
        "Absence and Substitute Management System",
        "University Space Management Software",
        "2026 01 APA Microsoft SharePoint Maintenance RFP",
        "Adaptation Clearinghouse Modernization Services",
        "Information Technology Equipment and Commodity Software",
        "IT System for Paid Family Medical Leave",
        "Mobile Application Security Testing",
        "Community Engagement Platform",
        "Azure Managed Services Provider",
        "Human Resources Information System",
        "Information Technologies Services",
        "IT Support Services",
        "Oracle EBusiness Suite EBS Process Assessment and Future State Design",
        "City of Springfield TN ERP Software for Electric Department",
        "RFP MDR Cybersecurity",
        "Computerized Maintenance Management System CMMS",
        "RFP Professional Consultants Services Geographical Information Systems Support",
        "Managed IT Services",
        "Enterprise Resource Planning Consulting Services",
        "Shoreline Permitting Workflow Management System",
    ],
}


def norm(s: str) -> str:
    s = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    s = re.sub(r"\s+", " ", s).strip()
    return s


def load_scored(date: str):
    p = DATA / f"scored-{date}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())["scored"]


# Build the searchable pool: every opportunity we've EVER scored across all days,
# keyed by normalized title for fuzzy match.
all_scored = {}
for f in sorted(DATA.glob("scored-*.json")):
    for o in json.loads(f.read_text())["scored"]:
        nt = norm(o["title"])
        # First occurrence wins (the run that first saw it)
        if nt not in all_scored:
            all_scored[nt] = {**o, "_first_seen_run": f.stem.replace("scored-", "")}
all_keys = list(all_scored.keys())


def best_match(target: str, threshold: float = 0.62):
    nt = norm(target)
    if nt in all_scored:
        return all_scored[nt], 1.0
    # First pass: substring containment
    contains = [k for k in all_keys if nt in k or k in nt]
    candidates = contains if contains else all_keys
    # Token overlap pre-filter for speed
    tgt_tokens = set(nt.split())
    if not contains:
        candidates = [k for k in all_keys if len(tgt_tokens & set(k.split())) >= 2]
    best, best_score = None, 0.0
    for k in candidates:
        score = SequenceMatcher(None, nt, k).ratio()
        if score > best_score:
            best, best_score = k, score
    if best and best_score >= threshold:
        return all_scored[best], best_score
    return None, best_score


# Bucket each team RFP
buckets = Counter()
detail = []
for date, titles in TEAM_RFPS.items():
    for t in titles:
        match, sim = best_match(t)
        if match is None:
            buckets["A_never_fetched"] += 1
            detail.append((date, t, "never_fetched", None, sim))
            continue
        score = match["score"]
        disq = match.get("disqualifiers") or []
        cat = "B_scored_low" if score < 60 else (
            "C_scored_high_but_flagged" if disq else "D_qualified"
        )
        buckets[cat] += 1
        detail.append((date, t, cat, match, sim))

print(f"\nTotal team RFPs analyzed: {sum(len(v) for v in TEAM_RFPS.values())}")
print(f"Pipeline scored pool (unique titles across all days): {len(all_scored)}")
print()
print("=== BUCKETS ===")
for k in sorted(buckets):
    print(f"  {k}: {buckets[k]}")
print()

# Per-bucket samples for the report
print("=== Bucket A — never fetched (no source/keyword caught it) — first 25 ===")
for d, t, b, m, sim in [x for x in detail if x[2] == "A_never_fetched"][:25]:
    print(f"  {d} | sim={sim:.2f} | {t[:80]}")

print()
print("=== Bucket B — fetched and scored, but BELOW the 60 cut — first 15 ===")
for d, t, b, m, sim in sorted([x for x in detail if x[2] == "B_scored_low"], key=lambda x: -x[4])[:15]:
    print(f"  {d} | sim={sim:.2f} | scored={m['score']:>2} sa={m['scoreBreakdown']['serviceAlignment']:>2} | team:{t[:55]:55} | matched:{m['title'][:55]}")

print()
print("=== Bucket C — scored ≥60 but flagged with disqualifiers (filtered out) — first 15 ===")
for d, t, b, m, sim in sorted([x for x in detail if x[2] == "C_scored_high_but_flagged"], key=lambda x: -m["score"])[:15]:
    print(f"  {d} | sim={sim:.2f} | scored={m['score']} | disq={m['disqualifiers']} | team:{t[:55]}")

print()
print("=== Bucket D — pipeline did surface it (qualified) — first 15 ===")
for d, t, b, m, sim in [x for x in detail if x[2] == "D_qualified"][:15]:
    print(f"  {d} | sim={sim:.2f} | scored={m['score']:>2} from {m['_first_seen_run']} | {m['title'][:70]}")

# Save full detail for analysis
out = Path("/tmp/coverage-detail.json")
out.write_text(json.dumps([
    {"team_date": d, "team_title": t, "bucket": b,
     "matched_title": m["title"] if m else None,
     "matched_score": m["score"] if m else None,
     "matched_disqualifiers": (m.get("disqualifiers") if m else None),
     "matched_id": m["id"] if m else None,
     "matched_first_seen_run": m.get("_first_seen_run") if m else None,
     "similarity": sim}
    for d, t, b, m, sim in detail
], indent=2))
print(f"\nFull detail saved to {out}")
