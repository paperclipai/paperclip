import json

with open("may_contacts.json") as f:
    contacts = json.load(f)

# Find contacts who have the SF Transaction Property Id (id: pBrSbW98iBClcG86M5fC)
sf_contacts = []
for c in contacts:
    has_sf = any(cf.get('id') == 'pBrSbW98iBClcG86M5fC' for cf in c.get('customFields', []))
    if has_sf:
        sf_contacts.append(c)

print(f"Found {len(sf_contacts)} SF contacts.")
for c in sf_contacts[:3]:
    print("--------------------------------------------")
    print(f"Contact Name: {c.get('contactName')}")
    print(f"Source: {c.get('source')}")
    print(f"Tags: {c.get('tags')}")
    print("Custom Fields:")
    for cf in c.get('customFields', []):
        print(f"  Field ID: {cf.get('id')} -> {cf.get('value')}")
