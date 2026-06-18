import json
import subprocess
from datetime import datetime, date

AE_MAP = {
    '003PX00000TOYYCYA5': 'Ivan Duarte',
    '0038V00002gyAi3QAE': 'Yauvan Kumar',
    '003PX00000IhSrsYAF': 'Zunaira Asghar',
    '003PX00000WeYtfYAF': 'Michael Simpson',
    '0038V00002rAw7OQAS': 'Christopher Mullen',
    '003PX00000GeuYhYAJ': 'Patrick Fleming'
}

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
    
    records = run_sf_query(soql)
    print(f"Total active records: {len(records)}")
    
    total_volume = 0
    by_ae = {}
    by_status = {}
    
    late_stage_loans = []
    
    today = date(2026, 5, 28) # May 28, 2026
    
    for r in records:
        status = r.get("MtgPlanner_CRM__Status__c")
        amount = r.get("MtgPlanner_CRM__Loan_Amount_1st_TD__c") or 0
        total_volume += amount
        
        ae_id = r.get("Account_Executive__c")
        ae_name = AE_MAP.get(ae_id, "MISSING/Unassigned")
        
        # AE aggregation
        if ae_name not in by_ae:
            by_ae[ae_name] = {"count": 0, "volume": 0}
        by_ae[ae_name]["count"] += 1
        by_ae[ae_name]["volume"] += amount
        
        # Status aggregation
        if status not in by_status:
            by_status[status] = {"count": 0, "volume": 0}
        by_status[status]["count"] += 1
        by_status[status]["volume"] += amount
        
        # Late stage detection
        if status in ('Underwriting Approved', 'Closing Scheduled', 'Loan in Process', 'Docs Out'):
            late_stage_loans.append({
                "name": r.get("Name"),
                "status": status,
                "amount": amount,
                "ae": ae_name,
                "lock_exp": r.get("MtgPlanner_CRM__Lock_Exp_Date_1st_TD__c")
            })
            
    print("\n--- Pipeline by AE ---")
    for ae, stats in sorted(by_ae.items(), key=lambda x: x[1]["volume"], reverse=True):
        print(f"  {ae:25}: {stats['count']:3} loans, ${stats['volume']/1000000:6.2f}M")
        
    print("\n--- Pipeline by Status ---")
    for status, stats in sorted(by_status.items(), key=lambda x: x[1]["volume"], reverse=True):
        print(f"  {status:25}: {stats['count']:3} loans, ${stats['volume']/1000000:6.2f}M")
        
    print(f"\nTotal Pipeline Volume: ${total_volume/1000000:.2f}M")
    
    if late_stage_loans:
        print("\n--- Late Stage Loans ---")
        for l in late_stage_loans:
            print(f"  {l['name']:30} | {l['status']:22} | ${l['amount']/1000:6.1f}K | AE: {l['ae']:15} | Lock Exp: {l['lock_exp']}")

if __name__ == "__main__":
    main()