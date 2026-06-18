import json

with open("may_contacts.json") as f:
    contacts = json.load(f)

if contacts:
    c = contacts[0]
    print("Keys:", list(c.keys()))
    print("Example contact:")
    print(json.dumps(c, indent=2))
