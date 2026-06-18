import json
from datetime import datetime, timezone

with open("may_contacts.json", "r") as f:
    contacts = json.load(f)

today = datetime(2026, 6, 15, tzinfo=timezone.utc)

def get_days_stalled(contact):
    date_added = datetime.fromisoformat(contact["dateAdded"].replace("Z", "+00:00"))
    return (today - date_added).days

buckets = {"A": [], "B": [], "C": []}
for c in contacts:
    is_pre_approval = False
    for cf in c.get("customFields", []):
        if cf.get("value") == "Pre-Approval Issued":
            is_pre_approval = True
            break
    if is_pre_approval:
        days = get_days_stalled(c)
        name = c.get("name", "Unknown")
        if days <= 120:
            buckets["A"].append(name)
        elif days <= 300:
            buckets["B"].append(name)
        else:
            buckets["C"].append(name)

print("Bucket A:")
for n in buckets["A"]: print(n)
print("\nBucket B:")
for n in buckets["B"]: print(n)
print("\nBucket C:")
for n in buckets["C"]: print(n)
