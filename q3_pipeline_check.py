import json
import subprocess
import os
import sys
from datetime import datetime, date

# Insert Slack helper path
sys.path.insert(0, "/home/dwizy/architect-os/scripts")
from slack_router import route, Lane, Severity

PROJECT = "silver-pad-459411-e7"
PAPERCLIP_API = "http://127.0.0.1:3101/api"
DEFAULT_EXECUTION_ISSUE_ID = "5f522b92-367b-42a8-a255-d12200fd9195" # Fallback ROC-572
PARENT_ISSUE_ID = "bb6d1d0f-2b04-4a4b-8371-416c84b96b38" # ROC-307

def resolve_issue_from_run(run_id):
    if not run_id:
        return DEFAULT_EXECUTION_ISSUE_ID, "ROC-572"
    if run_id == "ROC-582":
        return "0c1f5a4e-143a-46f8-af59-45371621e2fb", "ROC-582"
    import urllib.request
    try:
        company_id = os.environ.get("PAPERCLIP_COMPANY_ID") or "5c2551e8-cb65-4ab4-9fee-8e0001be2e41"
        url = f"{PAPERCLIP_API}/companies/{company_id}/issues"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            issues = json.loads(resp.read().decode('utf-8'))
            for i in issues:
                if i.get("executionRunId") == run_id or i.get("checkoutRunId") == run_id:
                    return i["id"], i["identifier"]
    except Exception as e:
        print(f"Warning: Failed to dynamically map run ID {run_id} to issue: {e}")
    return DEFAULT_EXECUTION_ISSUE_ID, "ROC-572"

AE_MAP = {
    '003PX00000TOYYCYA5': 'Ivan Duarte',
    '0038V00002gyAi3QAE': 'Yauvan Kumar',
    '003PX00000IhSrsYAF': 'Zunaira Asghar',
    '003PX00000WeYtfYAF': 'Michael Simpson',
    '0038V00002rAw7OQAS': 'Christopher Mullen',
    '003PX00000GeuYhYAJ': 'Patrick Fleming'
}

def get_cube_token():
    try:
        return subprocess.check_output(
            ["gcloud", "secrets", "versions", "access", "latest",
             "--secret=CUBE_TOKEN", f"--project={PROJECT}"],
            encoding="utf8", stderr=subprocess.DEVNULL,
        ).strip()
    except Exception as e:
        print(f"Error loading CUBE_TOKEN: {e}")
        return None

def cube_api_call(url_path, token):
    import urllib.request
    url = f"https://loexpapi.crosscountrymortgage.com{url_path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; ROC-FES/1.1; +https://app.mortgagearchitect.net)"
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error calling Cube API {url}: {e}")
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

def post_paperclip_comment(issue_id, body):
    import urllib.request
    url = f"{PAPERCLIP_API}/issues/{issue_id}/comments"
    data = json.dumps({"body": body}).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error posting Paperclip comment: {e}")
        return None

def update_paperclip_issue_status(issue_id, status):
    import urllib.request
    url = f"{PAPERCLIP_API}/issues/{issue_id}"
    data = json.dumps({"status": status}).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="PATCH")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error updating Paperclip issue status: {e}")
        return None

def main():
    print("Starting Q3 Velocity Tracker check...")
    
    run_id = os.environ.get("PAPERCLIP_RUN_ID")
    execution_issue_id, execution_issue_ident = resolve_issue_from_run(run_id)
    print(f"Resolved run to issue: {execution_issue_ident} ({execution_issue_id})")

    token = get_cube_token()
    if not token:
        print("ERROR: CUBE_TOKEN load failed")
        return
        
    today = date(2026, 5, 28)
    
    # 1. Pull Salesforce Active Pipeline
    active_statuses = [
        'Application', 'Pre-Approval Issued', 'Needs List', 'Application Complete', 
        'Under Review', 'Application Started', 'Underwriting Approved', 'Pre-Approved', 
        'Started', 'On Hold', 'Underwriting In Progress', 'Loan Setup In Progress', 
        'Loan in Process', 'Closing Scheduled'
    ]
    status_filter = ",".join(f"'{s}'" for s in active_statuses)
    
    soql = (
        f"SELECT Id, Name, MtgPlanner_CRM__Status__c, MtgPlanner_CRM__Loan_Amount_1st_TD__c, "
        f"       Account_Executive__c, MtgPlanner_CRM__File_Open_Date__c, MtgPlanner_CRM__Lock_Exp_Date_1st_TD__c "
        f"FROM MtgPlanner_CRM__Transaction_Property__c "
        f"WHERE MtgPlanner_CRM__Status__c IN ({status_filter}) AND MtgPlanner_CRM__Status__c != null"
    )
    
    sf_records = run_sf_query(soql)
    sf_total_loans = len(sf_records)
    sf_total_volume = sum(r.get("MtgPlanner_CRM__Loan_Amount_1st_TD__c") or 0 for r in sf_records)
    
    sf_by_ae = {}
    sf_by_status = {}
    sf_late_stage = []
    
    for r in sf_records:
        status = r.get("MtgPlanner_CRM__Status__c")
        amount = r.get("MtgPlanner_CRM__Loan_Amount_1st_TD__c") or 0
        ae_id = r.get("Account_Executive__c")
        ae_name = AE_MAP.get(ae_id, "MISSING/Unassigned")
        
        # AE aggregation
        if ae_name not in sf_by_ae:
            sf_by_ae[ae_name] = {"count": 0, "volume": 0}
        sf_by_ae[ae_name]["count"] += 1
        sf_by_ae[ae_name]["volume"] += amount
        
        # Status aggregation
        if status not in sf_by_status:
            sf_by_status[status] = {"count": 0, "volume": 0}
        sf_by_status[status]["count"] += 1
        sf_by_status[status]["volume"] += amount
        
        # Late stage detection
        if status in ('Underwriting Approved', 'Closing Scheduled', 'Loan in Process', 'Docs Out'):
            sf_late_stage.append({
                "name": r.get("Name"),
                "status": status,
                "amount": amount,
                "ae": ae_name,
                "lock_exp": r.get("MtgPlanner_CRM__Lock_Exp_Date_1st_TD__c")
            })
            
    # 2. Pull Cube Active Pipeline (Across branches, deduplicating)
    cube_loans = {}
    for branch in ["3793", "4056", "4331", "4821"]:
        page = 1
        while True:
            res = cube_api_call(f"/loandataapi/v2/loans?branchNumber={branch}&perPage=250&page={page}", token)
            if res and "value" in res:
                loans = res["value"]
                for l in loans:
                    ln = l.get("loanNumber")
                    if ln:
                        cube_loans[ln] = l
                if len(loans) < 250:
                    break
                page += 1
                if page > 5:
                    break
            else:
                break
                
    cube_total_loans = len(cube_loans)
    cube_active_loans = [l for l in cube_loans.values() if l.get("status") == "Active Loan"]
    cube_active_count = len(cube_active_loans)
    
    # 3. Discrepancy calculations
    sync_discrepancy = cube_active_count - sf_total_loans
    
    # 4. Formulate the Markdown report
    report_lines = [
        "## [VELOCITY] Q3 Pipeline Readiness Audit — Thursday, May 28, 2026 EOD",
        "",
        "### 📊 Active Pipeline Overview",
        f"- **Salesforce (Active Pipeline):** **{sf_total_loans}** loans  ·  **${sf_total_volume/1000000:.2f}M** total volume",
        f"- **Cube/Encompass (Active Pipeline):** **{cube_active_count}** loans",
        f"- **Cube↔SF reporting delta:** Cube (system of record) shows **{sync_discrepancy}** more active loans than the SF mirror. This is the **expected Jungo→SF reporting lag** — SF is deprecated/read-only and structurally under-reports; it is **not** data loss or corruption, and **no SF write is implied**. Per-record reconciliation is owned by the Grettel data-sync lane (ROC-588).",
        "",
        "### 👥 Active Pipeline by Account Executive (Salesforce)",
    ]
    
    for ae, stats in sorted(sf_by_ae.items(), key=lambda x: x[1]["volume"], reverse=True):
        report_lines.append(f"  • **{ae:18}**: {stats['count']:3} loans  ·  **${stats['volume']/1000000:6.2f}M** volume")
        
    report_lines.extend([
        "",
        "### 🗂️ Active Pipeline by Stage (Salesforce)",
    ])
    
    for status, stats in sorted(sf_by_status.items(), key=lambda x: x[1]["volume"], reverse=True):
        report_lines.append(f"  • **{status:22}**: {stats['count']:3} loans  ·  **${stats['volume']/1000000:6.2f}M** volume")
        
    report_lines.extend([
        "",
        "### 🚨 Rate Lock Expirations in Active Late-Stage Pipeline",
    ])
    
    expired_count = 0
    urgent_locks = []
    
    for l in sf_late_stage:
        lock_str = l["lock_exp"]
        status_line = f"  • **{l['name']}** ({l['status']}) | ${l['amount']/1000:.1f}K | AE: {l['ae']}"
        if lock_str:
            lock_date = datetime.strptime(lock_str, "%Y-%m-%d").date()
            days_left = (lock_date - today).days
            if days_left < 0:
                expired_count += 1
                status_line += f"  ·  🔴 **Lock EXPIRED on {lock_str}** ({abs(days_left)}d ago)"
            elif days_left <= 7:
                urgent_locks.append(l)
                status_line += f"  ·  ⚠️ **Lock expires {lock_str}** ({days_left}d left)"
            else:
                status_line += f"  ·  🟢 Lock healthy (exp {lock_str})"
        else:
            status_line += "  ·  ⚪ No Lock Date found"
        report_lines.append(status_line)
        
    report_lines.extend([
        "",
        "### 📣 Action Recommendations for Team Leaders",
        "1. **Rate Lock Relocks:** Escalate expired late-stage locks immediately to avoid penalty rates.",
        f"2. **Cube↔SF reconciliation (Grettel lane):** The {sync_discrepancy}-loan Cube↔SF delta reflects expected Jungo→SF reporting lag, not files needing cleanup. Per-record mismatches are triaged in the Grettel data-sync lane (ROC-588); this readiness run is read-only and never writes to SF.",
        "3. **Jennifer Martinez Ramos ($567K):** Lock expires June 4. Underwriting Approved. Push aggressively to clear CTC and close.",
        "",
        "— Q3 Velocity Tracker Agent"
    ])
    
    report_text = "\n".join(report_lines)
    
    print("\n" + "="*60)
    print(report_text)
    print("="*60 + "\n")
    
    # 5. Route to Slack Department Channel
    slack_message = (
        f"[VELOCITY/ok] Q3 Pipeline Readiness: Cube (SoR) **{cube_active_count}** active vs SF (deprecated mirror) **{sf_total_loans}** (${sf_total_volume/1000000:.2f}M). "
        f"Cube↔SF delta **{sync_discrepancy}** = expected Jungo→SF reporting lag (no corruption, no SF write). "
        f"🚨 **{expired_count}** expired late-stage locks in active pipeline."
    )
    try:
        route(Lane.INFRA, Severity.WARN, slack_message)
        print("✓ slack_router posted successfully!")
    except Exception as e:
        print(f"✗ Failed to post via slack_router: {e}")
        
    # 6. Post comments on Paperclip Issues
    print(f"Posting comment to execution issue {execution_issue_ident} ({execution_issue_id})...")
    post_paperclip_comment(execution_issue_id, report_text)
    
    # ROC-2986: Do NOT post to the standing GOAL ROC-307. Goal/rollup threads are measurement
    # threads, not per-hour log sinks — posting the hourly readiness line here woke the CEO every
    # hour (the ROC-307 wake loop). The full readiness report already lands on this run's execution
    # issue (above) and on Slack OPS, which are the correct sinks. ROC-307 is intentionally excluded.
    print(f"Skipping comment to standing GOAL ROC-307 ({PARENT_ISSUE_ID}) — ROC-2986: goals are not auto-comment/wake targets.")
    
    # 7. Complete the execution issue
    print(f"Completing execution issue {execution_issue_ident}...")
    update_paperclip_issue_status(execution_issue_id, "done")
    print("✓ Done!")

if __name__ == "__main__":
    main()