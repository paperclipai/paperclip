import json
from collections import Counter

with open("may_contacts.json") as f:
    contacts = json.load(f)

print(f"Total contacts: {len(contacts)}")

tags = []
for c in contacts:
    tags.extend(c.get('tags', []))

print("\nTop 50 tags:")
for tag, count in Counter(tags).most_common(50):
    print(f"  {tag}: {count}")
