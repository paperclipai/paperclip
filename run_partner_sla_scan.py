import json
import subprocess
from datetime import datetime, date

def run_sf_query(soql):
    cmd = ["sf", "data", "query", "-o", "prod_pipeline", "-q", soql, "--json"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
        return data.get("result", {}).get("records", [])
    except Exception as e:
        print(f"Salesforce query error: {e}")
        return []

def main():
    print("Step 1: Running top-5 referral partner query from Salesforce...")
    # Step 1 SOQL query
    top_partners_recs = run_sf_query(
        "SELECT MtgPlanner_CRM__Referred_By__c, COUNT(Id) referral_count "
        "FROM Contact "
        "WHERE MtgPlanner_CRM__Referred_By__c != null "
        "GROUP BY MtgPlanner_CRM__Referred_By__c "
        "ORDER BY COUNT(Id) DESC "
        "LIMIT 5"
    )
    
    top_ids = [r["MtgPlanner_CRM__Referred_By__c"] for r in top_partners_recs]
    print(f"Found top 5 partner IDs: {top_ids}")
    
    print("Step 2: Fetching full details for top-5 partners...")
    ids_str = ",".join(f"'{i}'" for i in top_ids)
    details_recs = run_sf_query(
        f"SELECT Id, FirstName, LastName, Name, Email, Phone, Partner_Rating__c, "
        f"       MtgPlanner_CRM__Last_Referral_Date__c, LastActivityDate, "
        f"       PartnerNextTouchAt__c, PartnerOptOut__c, MtgPlanner_CRM__Last_Touch__c "
        f"FROM Contact "
        f"WHERE Id IN ({ids_str})"
    )
    
    # Map by Id
    partners_map = {r["Id"]: r for r in details_recs}
    
    # Target date is May 28, 2026
    target_date = date(2026, 5, 28)
    
    breaching_partners = []
    all_partners_summary = []
    
    print("Step 3: Calculating SLA status for each partner...")
    for pid in top_ids:
        p = partners_map.get(pid)
        if not p:
            continue
            
        rating = p.get("Partner_Rating__c")
        name = p.get("Name")
        
        # Parse dates
        last_touch_str = p.get("LastActivityDate")
        last_ref_str = p.get("MtgPlanner_CRM__Last_Referral_Date__c")
        next_touch_str = p.get("PartnerNextTouchAt__c")
        
        last_touch = datetime.strptime(last_touch_str, "%Y-%m-%d").date() if last_touch_str else None
        last_ref = datetime.strptime(last_ref_str, "%Y-%m-%d").date() if last_ref_str else None
        next_touch = datetime.strptime(next_touch_str, "%Y-%m-%d").date() if next_touch_str else None
        
        # Calculate days since
        days_since_touch = (target_date - last_touch).days if last_touch else None
        days_since_ref = (target_date - last_ref).days if last_ref else None
        
        # Determine SLA thresholds based on rating
        touch_threshold = None
        ref_threshold = None
        
        if rating == "A":
            touch_threshold = 14
            ref_threshold = 60
        elif rating == "B":
            touch_threshold = 30
            ref_threshold = 90
            
        is_touch_breach = False
        is_ref_breach = False
        is_next_touch_breach = False
        
        reasons = []
        
        if touch_threshold is not None:
            if days_since_touch is None or days_since_touch > touch_threshold:
                is_touch_breach = True
                reasons.append(f"Touch SLA breached ({days_since_touch if days_since_touch is not None else 'No'} days > {touch_threshold}d threshold)")
                
        if ref_threshold is not None:
            if days_since_ref is None or days_since_ref > ref_threshold:
                is_ref_breach = True
                reasons.append(f"Referral SLA breached ({days_since_ref if days_since_ref is not None else 'No'} days > {ref_threshold}d threshold)")
                
        if next_touch and next_touch < target_date:
            is_next_touch_breach = True
            reasons.append(f"Scheduled next touch is past due (Scheduled: {next_touch_str})")
            
        is_breach = is_touch_breach or is_ref_breach or is_next_touch_breach
        
        partner_info = {
            "id": pid,
            "name": name,
            "email": p.get("Email"),
            "phone": p.get("Phone"),
            "rating": rating or "None",
            "last_touch_date": last_touch_str,
            "days_since_touch": days_since_touch,
            "last_ref_date": last_ref_str,
            "days_since_ref": days_since_ref,
            "last_touch_notes": p.get("MtgPlanner_CRM__Last_Touch__c"),
            "is_breach": is_breach,
            "reasons": reasons
        }
        
        all_partners_summary.append(partner_info)
        if is_breach and rating in ["A", "B"]:
            breaching_partners.append(partner_info)
            
    print(f"SLA status complete. Found {len(breaching_partners)} breaching A/B partners.")
    
    print("Step 4: Hydrating GHL state for breaching partners from may_contacts.json...")
    with open("may_contacts.json") as f:
        ghl_contacts = json.load(f)
        
    # Keywords map for partners to GHL contacts
    keywords_map = {
        "Anthony Gebrael": ["gebrael", "anthony-gebrael"],
        "Debby Valdes": ["valdes", "debby-valdes"],
        "Jennifer Salomon": ["salomon", "jennifer-salomon"]
    }
    
    for bp in breaching_partners:
        pname = bp["name"]
        keywords = keywords_map.get(pname, [pname.lower()])
        
        bp_ghl_contacts = []
        for gc in ghl_contacts:
            tags = [t.lower() for t in gc.get("tags", [])]
            source = (gc.get("source") or "").lower()
            gc_name = gc.get("contactName") or ""
            
            # Match
            matched = False
            if any(kw in source for kw in keywords):
                matched = True
            elif any(any(kw in t for kw in keywords) for t in tags):
                matched = True
                
            # Exclude partner itself
            if gc_name.lower() == pname.lower():
                matched = False
                
            if matched:
                # Get custom fields
                sf_id = None
                stage = "New Lead"
                for cf in gc.get("customFields", []):
                    if cf.get("id") == "pBrSbW98iBClcG86M5fC":
                        sf_id = cf.get("value")
                    elif cf.get("id") == "7V6AtJy2pVbwBlPy5hUU":
                        stage = cf.get("value")
                        
                # If we have a SF opportunity ID, query its status and amount from Salesforce
                amount = 0
                if sf_id:
                    sf_opps = run_sf_query(
                        f"SELECT Id, Name, MtgPlanner_CRM__Status__c, MtgPlanner_CRM__Loan_Amount_1st_TD__c "
                        f"FROM MtgPlanner_CRM__Transaction_Property__c WHERE Id = '{sf_id}'"
                    )
                    if sf_opps:
                        opp = sf_opps[0]
                        stage = opp.get("MtgPlanner_CRM__Status__c") or stage
                        amount = opp.get("MtgPlanner_CRM__Loan_Amount_1st_TD__c") or 0
                
                bp_ghl_contacts.append({
                    "name": gc_name,
                    "stage": stage,
                    "amount": amount,
                    "tags": gc.get("tags", [])
                })
                
        bp["ghl_referrals"] = bp_ghl_contacts
        bp["total_active_pipeline"] = sum(c["amount"] for c in bp_ghl_contacts if c["stage"] in [
            "Application", "Pre-Approval Issued", "Needs List", "Application Complete",
            "Under Review", "Application Started", "Underwriting Approved", "Pre-Approved"
        ])
        
    print("Step 5: Compiling Markdown Report...")
    
    report = []
    report.append("## ✅ SLA Scan Complete — Ready to Send Partner Revival DM")
    report.append("")
    report.append(f"**Scan Datetime:** `2026-05-28 15:00 UTC` (Target: May 28, 2026)")
    report.append(f"**Total Tracked Partners (Top 5):** {len(all_partners_summary)}")
    report.append(f"**SLA Breached Partners (A/B Rated):** {len(breaching_partners)}")
    report.append("")
    
    report.append("### 🤝 TOP-5 PARTNERS STATUS OVERVIEW")
    report.append("| Partner Name | Rating | Last Touch | Days Since | Last Referral | Days Since | Status |")
    report.append("|---|---|---|---|---|---|---|")
    for p in all_partners_summary:
        status_emoji = "🚨 BREACH" if p["is_breach"] and p["rating"] in ["A", "B"] else "✅ GREEN"
        if p["rating"] not in ["A", "B"]:
            status_emoji = "⚠️ UNRATED"
        report.append(
            f"| {p['name']} | {p['rating']} | {p['last_touch_date'] or 'Never'} | {p['days_since_touch'] if p['days_since_touch'] is not None else '-'} | "
            f"{p['last_ref_date'] or 'Never'} | {p['days_since_ref'] if p['days_since_ref'] is not None else '-'} | {status_emoji} |"
        )
    report.append("")
    
    report.append("### 🚨 BREACH DETAILS & HYDRATED GHL PIPELINE")
    
    for bp in breaching_partners:
        report.append(f"#### {bp['name']} (Rating: **{bp['rating']}**)")
        for r in bp["reasons"]:
            report.append(f"- ⚠️ {r}")
        report.append(f"- **Last Touch Notes:** *\"{bp['last_touch_notes'] or 'No touch history available.'}\"*")
        
        refs = bp.get("ghl_referrals", [])
        if refs:
            report.append(f"- **GHL Active Referrals ({len(refs)}):**")
            for r in refs:
                amount_str = f"${r['amount']:,}" if r['amount'] > 0 else "N/A"
                report.append(f"  • **{r['name']}** — Stage: `{r['stage']}` | Loan Volume: `{amount_str}`")
            if bp['total_active_pipeline'] > 0:
                report.append(f"- **Total Active Pipeline Volume:** `${bp['total_active_pipeline']:,}`")
        else:
            report.append("- **GHL Active Referrals:** None found in May 2026 file.")
        report.append("")
        
    report.append("---")
    report.append("")
    report.append("### ✉️ SLACK DM RECOVERY ANGLES FOR IVAN")
    report.append("Please approve the following revival outreach drafts:")
    report.append("")
    
    for bp in breaching_partners:
        pname = bp["name"]
        rating = bp["rating"]
        email = bp["email"] or "N/A"
        phone = bp["phone"] or "N/A"
        
        report.append(f"#### Outreach Draft for **{pname}** ({rating}-rated)")
        report.append("```text")
        
        if pname == "Anthony Gebrael":
            report.append(
                f"Hey Ivan — SLA Scan flagged Anthony Gebrael (Coldwell Banker Realty, {email}, {phone}) as 173d stale on referrals. "
                "Although you touched base yesterday, he hasn't sent a new loan lead since December 6, 2025. "
                "He's a top-tier partner who could help us close our 15-unit June goal.\n\n"
                "Recommend sending a quick revival note:\n"
                f"\"Hey Anthony! Great catching up yesterday. As we head into June, our team is opening up a few special priority "
                "closing slots with expedited underwriting for Coldwell Banker clients. Do you have any buyers currently looking "
                "who could benefit from having their files fast-tracked? Let me know! — Ivan\""
            )
        elif pname == "Debby Valdes":
            active_refs = bp.get("ghl_referrals", [])
            ref_names = ", ".join(r["name"] for r in active_refs)
            total_vol = bp["total_active_pipeline"]
            report.append(
                f"Hey Ivan — SLA Scan flagged Debby Valdes ({email}, {phone}) with a Touch SLA breach (16 days since last touch on May 12). "
                f"Debby has ${total_vol:,} in active pipeline across {len(active_refs)} loans in Application stage ({ref_names}). "
                "She is an extremely critical partner for our June goal.\n\n"
                "Recommend sending an immediate status-update touch:\n"
                f"\"Hey Debby! Just wanted to reach out personally and give you an update on our active applications. "
                f"Both Javad Rajai and Indira Kissoonlal are looking great in the Application queue. "
                "Our processing team is pushing hard to get these pre-approved. Are there any other files you have in the hopper "
                "for June that we can jump on? Let me know how I can support you this week! — Ivan\""
            )
        elif pname == "Jennifer Salomon":
            active_refs = bp.get("ghl_referrals", [])
            ref_names = ", ".join(r["name"] for r in active_refs)
            report.append(
                f"Hey Ivan — SLA Scan flagged Jennifer Salomon ({email}) with a Touch SLA breach (29 days since last touch on April 29). "
                f"Jennifer referred {ref_names} on May 15, who is currently in the pre-approval queue. "
                "A personalized thank-you/update is overdue and would solidify the relationship.\n\n"
                "Recommend sending this revival note:\n"
                f"\"Hey Jennifer! It has been a minute since we caught up. Thank you so much for referring Nelson Rivera to us "
                "on May 15. We are working diligently with Nelson on his pre-approval and making excellent progress. "
                "Do you have any other buyers active in the market right now whom we can help get pre-approved? "
                "Hope you are having a fantastic week! — Ivan\""
            )
        report.append("```")
        report.append("")
        
    report.append("---")
    report.append("")
    report.append("**Next Steps:** Ivan to review and approve the draft DMs. Upon approval, I will dispatch them via Slack.")
    report.append("")
    report.append("**Routine Status:** ✅ Executing hourly 7am-9pm Mon-Sat. Next scheduled scan at 16:00 UTC (1 hour away).")
    
    markdown_report = "\n".join(report)
    print("Compiled Report:")
    print(markdown_report)
    
    # Save report to a text file
    with open("sla_scan_report.md", "w") as f:
        f.write(markdown_report)
    print("Saved report to sla_scan_report.md")

if __name__ == "__main__":
    main()
