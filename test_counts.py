import json
from datetime import datetime, timezone

with open("may_contacts.json") as f:
    contacts = json.load(f)

# Dates of interest:
# Today: May 28, 2026
# This week: Monday, May 25, 2026 to end
# MTD: May 1, 2026 to end

today_start = datetime(2026, 5, 28, 0, 0, 0, tzinfo=timezone.utc)
week_start = datetime(2026, 5, 25, 0, 0, 0, tzinfo=timezone.utc)
month_start = datetime(2026, 5, 1, 0, 0, 0, tzinfo=timezone.utc)

for name, start_dt in [("Today", today_start), ("This Week", week_start), ("MTD", month_start)]:
    total_contacts = 0
    source_contacts = 0
    for c in contacts:
        dt = datetime.fromisoformat(c['dateAdded'].replace('Z', '+00:00'))
        if dt >= start_dt:
            total_contacts += 1
            has_source = any(t.startswith('source-') or t.startswith('source:') for t in c.get('tags', []))
            if has_source:
                source_contacts += 1
    print(f"{name}: Total Contacts = {total_contacts}, Contacts with source tag = {source_contacts}")
