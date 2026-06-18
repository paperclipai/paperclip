import json
from datetime import datetime, timezone

with open("may_contacts.json", "r") as f:
    contacts = json.load(f)

# Current date: 2026-06-15
today = datetime(2026, 6, 15, tzinfo=timezone.utc)

def get_days_stalled(contact):
    date_added = datetime.fromisoformat(contact["dateAdded"].replace("Z", "+00:00"))
    return (today - date_added).days

buckets = {"A": 0, "B": 0, "C": 0}
for c in contacts:
    is_pre_approval = False
    for cf in c.get("customFields", []):
        if cf.get("value") == "Pre-Approval Issued":
            is_pre_approval = True
            break
    if is_pre_approval:
        days = get_days_stalled(c)
        if days <= 120:
            buckets["A"] += 1
        elif days <= 300:
            buckets["B"] += 1
        else:
            buckets["C"] += 1

print(f"Bucket A: {buckets['A']} | Bucket B: {buckets['B']} | Bucket C: {buckets['C']}")
