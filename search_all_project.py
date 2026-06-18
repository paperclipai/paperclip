import os
import re

print("Searching for Blend/Salesforce/SF/GHL/services.leadconnectorhq.com references...")
patterns = [
    re.compile(r'blend', re.IGNORECASE),
    re.compile(r'salesforce', re.IGNORECASE),
    re.compile(r'leadconnectorhq', re.IGNORECASE),
    re.compile(r'blend.*\.com', re.IGNORECASE),
    re.compile(r'salesforce.*\.com', re.IGNORECASE)
]

for root, dirs, files in os.walk('.'):
    # Skip build/dependency dirs
    for d in ['node_modules', '.git', 'dist', '.pnpm-store', '.paperclip', 'ui/dist']:
        if d in dirs:
            dirs.remove(d)
            
    for file in files:
        if file.endswith(('.ts', '.js', '.json', '.sql', '.py')):
            path = os.path.join(root, file)
            try:
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                for p in patterns:
                    matches = p.findall(content)
                    if matches:
                        print(f"File {path}: matched {p.pattern} (count {len(matches)})")
                        # Print sample lines
                        for line in content.splitlines():
                            if p.search(line):
                                print(f"  Line: {line[:120].strip()}")
                        break
            except Exception as e:
                pass
