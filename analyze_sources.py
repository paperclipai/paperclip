import json
from collections import Counter

with open("may_contacts.json") as f:
    contacts = json.load(f)

source_tags = []
for c in contacts:
    for t in c.get('tags', []):
        if t.startswith('source-') or t.startswith('source:'):
            source_tags.append(t)

print(Counter(source_tags))
