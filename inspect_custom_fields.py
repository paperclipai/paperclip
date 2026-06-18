import json

with open("may_contacts.json") as f:
    contacts = json.load(f)

custom_fields_seen = {}
for c in contacts:
    for cf in c.get('customFields', []):
        id_ = cf.get('id')
        val = cf.get('value')
        if id_ not in custom_fields_seen:
            custom_fields_seen[id_] = []
        if val is not None and val != "" and len(custom_fields_seen[id_]) < 5:
            custom_fields_seen[id_].append(val)

print("Custom fields structure:")
for id_, vals in custom_fields_seen.items():
    print(f"Field ID: {id_} -> Example values: {vals}")
