import os
import re

print("Searching server/src for Blend/Salesforce/Partners/Funnel...")
patterns = [
    re.compile(r'blend', re.IGNORECASE),
    re.compile(r'salesforce', re.IGNORECASE),
    re.compile(r'partner', re.IGNORECASE),
    re.compile(r'funnel', re.IGNORECASE),
]

for root, dirs, files in os.walk('server/src'):
    for file in files:
        path = os.path.join(root, file)
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            for p in patterns:
                matches = p.findall(content)
                if matches:
                    print(f"File {path}: matched {p.pattern} (count {len(matches)})")
                    for line in content.splitlines():
                        if p.search(line):
                            print(f"  Line: {line[:120].strip()}")
                    break
        except Exception as e:
            pass
