#!/usr/bin/env python3
"""
Batch wire components to use translation keys.
This replaces hardcoded strings with t() calls using systematic patterns.
"""

import re
from pathlib import Path

# String replacements: (file_path, old_string, new_string, namespace)
replacements = [
    # IssueChatThread.tsx - Input/Result labels
    ('ui/src/components/IssueChatThread.tsx', '                  Input', '                  {t("input")}', 'issues', 2),
    ('ui/src/components/IssueChatThread.tsx', '                  Result', '                  {t("result")}', 'issues', 1),
    ('ui/src/components/IssueChatThread.tsx', '            Follow-up', '            {t("follow_up")}', 'issues', 2),
    ('ui/src/components/IssueChatThread.tsx', '      : "Agent"', '      : t("agent")', 'issues', 1),
]

def apply_replacements():
    """Apply string replacements to component files."""

    for file_path, old_str, new_str, namespace, expected_count in replacements:
        path = Path(file_path)
        if not path.exists():
            print(f"[FAIL] File not found: {file_path}")
            continue

        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Count occurrences
        count = content.count(old_str)
        if count == 0:
            print(f"[WARN] No matches found in {file_path}: '{old_str}'")
            continue

        if count != expected_count:
            print(f"[WARN] Found {count} matches (expected {expected_count}) in {file_path}")

        # Replace
        new_content = content.replace(old_str, new_str)

        # Only write if translation import exists for this namespace
        if f'useTranslation("{namespace}")' in new_content or f"useTranslation('{namespace}')" in new_content:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"[OK] Updated {file_path}: {count} replacement(s)")
        else:
            print(f"[FAIL] {file_path} missing useTranslation('{namespace}') - skipped")

if __name__ == '__main__':
    print("Batch Wire Components")
    print("=" * 60)
    apply_replacements()
    print("\nDone! Run: npm run typecheck")
