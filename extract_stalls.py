import json

with open("may_contacts.json", "r") as f:
    contacts = json.load(f)

stalls = []
for c in contacts:
    is_pre_approval = False
    for cf in c.get("customFields", []):
        if cf.get("value") == "Pre-Approval Issued":
            is_pre_approval = True
            break
    if is_pre_approval:
        stalls.append(c)

print(len(stalls))
# Print the first one to see the full structure
if stalls:
    print(json.dumps(stalls[0], indent=2))
