import sys
import os
import urllib.request
import json
import subprocess
from datetime import datetime, timezone, timedelta

# Add architect-os/scripts to path to import Slack
sys.path.insert(0, "/home/dwizy/architect-os/scripts")

# Config GHL
API_KEY = "pit-1138def5-390b-4ffb-b8e9-30b2ea6b5990"
GHL_BASE_URL = "https://services.leadconnectorhq.com"
LOCATION_ID = "y5eLFi2NFVoin9FxJiyc"

def ghl_api_call(url_path, method="GET", body=None):
    if url_path.startswith("http"):
        url = url_path
    else:
        url = f"{GHL_BASE_URL}{url_path}"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Version": "2021-07-28",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Origin": "https://app.gohighlevel.com",
        "Referer": "https://app.gohighlevel.com/"
    }
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        if hasattr(e, 'read'):
            print(f"Error calling {url}: {e.read().decode('utf-8')}")
        else:
            print(f"Error calling {url}: {e}")
        return None

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
    print("1. Gathering GHL leads & applications data...")
    # Time zones (ET is UTC - 4)
    now_utc = datetime.now(timezone.utc)
    now_et = now_utc - timedelta(hours=4)
    
    today_start_et = datetime(now_et.year, now_et.month, now_et.day, tzinfo=timezone(timedelta(hours=-4)))
    monday_start_et = today_start_et - timedelta(days=today_start_et.weekday())
    mtd_start_et = datetime(now_et.year, now_et.month, 1, tzinfo=timezone(timedelta(hours=-4)))
    
    all_contacts_mtd = []
    url = f"/contacts/?locationId={LOCATION_ID}&limit=100"
    
    while url:
        res = ghl_api_call(url)
        if not res:
            break
        contacts = res.get("contacts", [])
        if not contacts:
            break
        
        reached_end = False
        for c in contacts:
            date_added_str = c.get("dateAdded")
            if not date_added_str:
                continue
            date_added = datetime.fromisoformat(date_added_str.replace("Z", "+00:00"))
            if date_added < mtd_start_et:
                reached_end = True
                break
            all_contacts_mtd.append((c, date_added))
            
        if reached_end:
            break
        
        meta = res.get("meta", {})
        url = meta.get("nextPageUrl")

    # Counts
    leads_today = 0
    leads_this_week = 0
    leads_mtd = 0
    
    apps_today = 0
    apps_this_week = 0
    apps_mtd = 0
    
    for c, dt in all_contacts_mtd:
        tags = c.get("tags", [])
        has_source_tag = any(t.startswith("source-") or t.startswith("source:") for t in tags)
        has_app_submitted = "blend-app-submitted" in tags
        
        if has_source_tag:
            leads_mtd += 1
            if dt >= today_start_et:
                leads_today += 1
            if dt >= monday_start_et:
                leads_this_week += 1
                
        if has_app_submitted:
            apps_mtd += 1
            if dt >= today_start_et:
                apps_today += 1
            if dt >= monday_start_et:
                apps_this_week += 1

    conversion_rate = (apps_mtd / leads_mtd * 100) if leads_mtd > 0 else 0.0

    print("2. Gathering Salesforce pipeline snapshot...")
    active_statuses = [
        'Application', 'Pre-Approval Issued', 'Needs List', 'Application Complete', 
        'Under Review', 'Application Started', 'Underwriting Approved', 'Pre-Approved', 
        'Started', 'On Hold', 'Underwriting In Progress', 'Loan Setup In Progress', 
        'Loan in Process', 'Closing Scheduled'
    ]
    status_filter = ",".join(f"'{s}'" for s in active_statuses)
    
    pipeline_recs = run_sf_query(
        f"SELECT Id, Name, Stage__c, MtgPlanner_CRM__Status__c, MtgPlanner_CRM__Loan_Amount_1st_TD__c "
        f"FROM MtgPlanner_CRM__Transaction_Property__c "
        f"WHERE MtgPlanner_CRM__Status__c IN ({status_filter}) AND MtgPlanner_CRM__Status__c != null"
    )
    
    pipeline_by_status = {}
    total_count = len(pipeline_recs)
    total_volume = 0
    
    for r in pipeline_recs:
        status = r.get("MtgPlanner_CRM__Status__c") or "Unknown"
        amount = r.get("MtgPlanner_CRM__Loan_Amount_1st_TD__c") or 0
        total_volume += amount
        if status not in pipeline_by_status:
            pipeline_by_status[status] = {"count": 0, "volume": 0}
        pipeline_by_status[status]["count"] += 1
        pipeline_by_status[status]["volume"] += amount

    # Sort statuses by count descending
    sorted_statuses = sorted(pipeline_by_status.items(), key=lambda x: x[1]["count"], reverse=True)

    print("3. Gathering Salesforce referring partners info...")
    # Partners who sent leads this week
    partners_this_week_recs = run_sf_query(
        "SELECT MtgPlanner_CRM__Referred_By__r.Name Name, COUNT(Id) Cnt "
        "FROM Contact "
        "WHERE CreatedDate = THIS_WEEK AND MtgPlanner_CRM__Referred_By__c != null "
        "GROUP BY MtgPlanner_CRM__Referred_By__r.Name "
        "ORDER BY COUNT(Id) DESC"
    )
    
    # Partners with active loans in pipeline
    partners_active_pipeline_recs = run_sf_query(
        f"SELECT MtgPlanner_CRM__Borrower_Name__r.MtgPlanner_CRM__Referred_By__r.Name Name, COUNT(Id) Cnt "
        f"FROM MtgPlanner_CRM__Transaction_Property__c "
        f"WHERE MtgPlanner_CRM__Status__c IN ({status_filter}) "
        f"  AND MtgPlanner_CRM__Borrower_Name__r.MtgPlanner_CRM__Referred_By__c != null "
        f"GROUP BY MtgPlanner_CRM__Borrower_Name__r.MtgPlanner_CRM__Referred_By__r.Name "
        f"ORDER BY COUNT(Id) DESC"
    )
    
    # MTD lead count per partner
    partners_mtd_recs = run_sf_query(
        "SELECT MtgPlanner_CRM__Referred_By__r.Name Name, COUNT(Id) Cnt "
        "FROM Contact "
        "WHERE CreatedDate = THIS_MONTH AND MtgPlanner_CRM__Referred_By__c != null "
        "GROUP BY MtgPlanner_CRM__Referred_By__r.Name "
        "ORDER BY COUNT(Id) DESC "
        "LIMIT 15"
    )

    print("4. Compiling the Funnel Intelligence Morning Brief...")
    today_label = now_et.strftime("%A, %B %d, %Y")
    
    brief = []
    brief.append(f"*[FUNNEL] Morning Brief — {today_label}* 🚀")
    brief.append("")
    brief.append("1. 📊 *LEAD & APPLICATION COUNTERS*")
    brief.append(f"  • *New Loan Leads:* today: {leads_today}  ·  this week: {leads_this_week}  ·  MTD: {leads_mtd}")
    brief.append(f"  • *New Applications:* today: {apps_today}  ·  this week: {apps_this_week}  ·  MTD: {apps_mtd}")
    brief.append(f"  • *Lead ➔ App Conversion (MTD):* {conversion_rate:.2f}%")
    brief.append("")
    brief.append("2. 🗂️ *PIPELINE SNAPSHOT*")
    brief.append(f"  • *Total Active Pipeline:* {total_count} loans  ·  *${total_volume/1000000:.2f}M* volume")
    brief.append("  • *Pipeline by Stage:*")
    
    # List top active stages
    for status, data in sorted_statuses[:8]:
        status_vol_m = data["volume"] / 1000000
        brief.append(f"    - {status}: {data['count']} loans (${status_vol_m:.2f}M)")
    if len(sorted_statuses) > 8:
        other_loans = sum(v["count"] for k, v in sorted_statuses[8:])
        other_vol_m = sum(v["volume"] for k, v in sorted_statuses[8:]) / 1000000
        brief.append(f"    - Other Deep Stages: {other_loans} loans (${other_vol_m:.2f}M)")
        
    brief.append("")
    brief.append("3. 🤝 *TOP REFERRING PARTNERS*")
    
    # Partners who sent leads this week
    pw = [f"{r.get('Name')} ({r.get('Cnt')})" for r in partners_this_week_recs]
    pw_str = ", ".join(pw) if pw else "None yet"
    brief.append(f"  • *Leads Sent This Week:* {pw_str}")
    
    # Partners with active loans in pipeline
    pa = [f"{r.get('Name')} ({r.get('Cnt')})" for r in partners_active_pipeline_recs[:5]]
    pa_str = ", ".join(pa) if pa else "None"
    brief.append(f"  • *Active Loans in Pipeline:* {pa_str}")
    
    # MTD lead count per partner
    pmtd = [f"{r.get('Name')} ({r.get('Cnt')})" for r in partners_mtd_recs[:10]]
    pmtd_str = ", ".join(pmtd) if pmtd else "None"
    brief.append(f"  • *MTD Lead Counts:* {pmtd_str}")
    
    brief.append("")
    brief.append("Next brief: tomorrow 8:00 AM ET  ·  — INTAKE-AGENT")

    brief_text = "\n".join(brief)
    
    print("\n" + "="*60)
    print(brief_text)
    print("="*60 + "\n")
    
    print("5. Delivering Slack DM to Ivan (U0AN77C2DF0)...")
    try:
        from slack_helper import Slack
        slack = Slack()
        res = slack.post("U0AN77C2DF0", brief_text)
        print("✓ Brief posted successfully! Slack response:", res.get("ok"))
    except Exception as e:
        print(f"✗ Failed to post to Slack: {e}")

if __name__ == "__main__":
    main()
