import json
import os

def load_pl_data(filepath="/home/dwizy/.roc-workday-pl/pl-structured.json"):
    with open(filepath, "r") as f:
        return json.load(f)

def analyze_pl(data):
    # Basic analysis: return summarized metrics
    # Monthly revenue, COGS (if available), Opex, Margin
    # Based on the structure, we have lock_revenue + origination_fees
    
    analysis = []
    months = data["currentYear"]["months"]
    for m in months:
        rev = m["lock_revenue"] + m["origination_fees"]
        analysis.append({
            "month": m["month"],
            "revenue": rev,
            "net_income": m["net_income"],
            "units": m["units"]
        })
    return analysis

if __name__ == "__main__":
    data = load_pl_data()
    results = analyze_pl(data)
    print(json.dumps(results, indent=2))
