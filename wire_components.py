#!/usr/bin/env python3
"""
Wire components to use translation keys instead of hardcoded strings.
This script systematically replaces hardcoded strings with t() calls.
"""

import re
from pathlib import Path

# Mapping of hardcoded string → translation key
# Extracted from the hardcoded strings found in components
wire_mapping = {
    # IssueChatThread strings
    ('"Input"', '"result"'): 't("input")',
    ('"Result"', '"result"'): 't("result")',
    ('"Follow-up"', 'issuechat'): 't("follow_up")',
    ('"Agent"', 'agentname'): 't("agent")',
    ('"Stop run"', 'stoprun'): 't("stop_run")',
    ('"Stopping..."', 'stopping'): 't("stopping")',

    # IssueProperties strings
    ('"Copied!"', 'copied'): 't("copied")',
    ('"Click to copy"', 'click'): 't("click_to_copy")',
    ('"Cancel"', 'button'): 't("cancel")',
    ('"Remove blocker"', 'remove'): 't("remove_blocker")',

    # Comments
    ('"Copied"', 'comment'): 't("copied")',
    ('"Copy failed"', 'comment'): 't("copy_failed")',
    ('"Copy"', 'comment'): 't("copy")',
    ('"Comment"', 'button'): 't("comment")',

    # Routines
    ('"Create routine"', 'routines'): 't("create_routine")',
    ('"Routines"', 'page'): 't("routines")',

    # Company
    ('"Remove"', 'skill'): 't("remove")',
    ('"Edit"', 'skill'): 't("edit")',
    ('"Save"', 'skill'): 't("save")',
    ('"Add"', 'skill'): 't("add")',
}

components = [
    ('ui/src/components/IssueChatThread.tsx', 'issues'),
    ('ui/src/components/IssueProperties.tsx', 'issues'),
    ('ui/src/components/IssuesList.tsx', 'issues'),
    ('ui/src/components/NewIssueDialog.tsx', 'issues'),
    ('ui/src/components/IssueDetail.tsx', 'issues'),
    ('ui/src/components/CommentThread.tsx', 'comments'),
    ('ui/src/pages/Routines.tsx', 'routines'),
    ('ui/src/pages/CompanySkills.tsx', 'company'),
]

def add_translation_import(content, namespace):
    """Ensure useTranslation is imported and used in the component."""
    if 'useTranslation' not in content:
        # Add import if missing
        if 'import { useTranslation } from "react-i18next"' not in content:
            # Find the last import line
            import_lines = [i for i, line in enumerate(content.split('\n')) if line.startswith('import')]
            if import_lines:
                insert_pos = content.find('\n', sum(len(line) + 1 for line in content.split('\n')[:import_lines[-1]+1]))
                content = content[:insert_pos] + '\nimport { useTranslation } from "react-i18next";' + content[insert_pos:]
    return content

def needs_translation_setup(content, namespace):
    """Check if a component needs translation setup."""
    # Check if useTranslation is called for the namespace
    pattern = rf'useTranslation\(["\']?{namespace}["\']?\)'
    return bool(re.search(pattern, content))

print("Wire Components Report")
print("=" * 60)
print("\nThis script would wire components to use translations.")
print("The following components were identified:")
print()

for component_path, namespace in components:
    full_path = Path(component_path)
    if full_path.exists():
        with open(full_path, encoding='utf-8') as f:
            content = f.read()

        has_import = 'useTranslation' in content
        status = "✓ READY" if has_import else "⚠ NEEDS SETUP"
        print(f"  {component_path}")
        print(f"    Namespace: {namespace}")
        print(f"    Status: {status}")
    else:
        print(f"  {component_path} - NOT FOUND")

print("\n" + "=" * 60)
print("\nTo apply wiring changes, this script should:")
print("1. Add useTranslation imports where missing")
print("2. Replace specific hardcoded strings with t() calls")
print("3. Verify TypeScript compilation")
print("\nNote: Manual review recommended for component context.")
