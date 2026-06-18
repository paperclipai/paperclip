import re
with open('packages/db/src/migrations/meta/_journal.json', 'r') as f:
    text = f.read()

# I will just take up to 0091, then append 0092 and 0093.
match = re.search(r'"tag": "0091_old_swarm",\s*"breakpoints": true\s*\}', text)
if match:
    base = text[:match.end()]
    new_tail = """,
    {
      "idx": 92,
      "version": "7",
      "when": 1716912344000,
      "tag": "0092_fantastic_morgan_stark",
      "breakpoints": true
    },
    {
      "idx": 93,
      "version": "7",
      "when": 1716912345000,
      "tag": "0093_routing_table",
      "breakpoints": true
    }
  ]
}"""
    with open('packages/db/src/migrations/meta/_journal.json', 'w') as f:
        f.write(base + new_tail)
