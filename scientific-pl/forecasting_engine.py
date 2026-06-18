import json
import os

def load_pl_data(filepath="/home/dwizy/.roc-workday-pl/pl-structured.json"):
    with open(filepath, "r") as f:
        return json.load(f)

def run_analysis(data):
    # Analyzing current year trajectory vs goal ($100M)
    months = data["currentYear"]["months"]
    
    total_ytd_rev = data["currentYear"]["ytd"]["lock_revenue"] + data["currentYear"]["ytd"]["origination_fees"]
    ytd_units = data["currentYear"]["ytd"]["units"]
    
    # Simple linear projection for remainder of the year (7 months left)
    months_passed = len(months)
    remaining_months = 12 - months_passed
    
    avg_rev_per_month = total_ytd_rev / months_passed
    avg_units_per_month = ytd_units / months_passed
    
    projected_rev = total_ytd_rev + (avg_rev_per_month * remaining_months)
    projected_units = ytd_units + (avg_units_per_month * remaining_months)
    
    return {
        "months_passed": months_passed,
        "ytd_revenue": total_ytd_rev,
        "ytd_units": ytd_units,
        "projected_annual_revenue": projected_rev,
        "projected_annual_units": projected_units,
        "target_units": 180,
        "gap_units": 180 - projected_units
    }

if __name__ == "__main__":
    data = load_pl_data()
    analysis = run_analysis(data)
    print(json.dumps(analysis, indent=2))
