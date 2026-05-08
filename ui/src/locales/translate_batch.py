#!/usr/bin/env python3
"""
Batch translation script for ZAI-286.
Translates ~330 English strings to 8 locales using Claude API with prompt caching.
Uses Approach 3: multi-call script with caching for maximum efficiency.
"""

import json
import re
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import anthropic

# Configuration
LOCALES = ["de", "el", "es", "pt", "ru", "uk", "zh"]  # 8 target locales (excluding en)
LOCALE_NAMES = {
    "de": "German",
    "el": "Greek",
    "es": "Spanish",
    "pt": "Portuguese",
    "ru": "Russian",
    "uk": "Ukrainian",
    "zh": "Chinese (Simplified)",
}

# Paths
BASE_DIR = Path(__file__).parent
LOCALES_DIR = BASE_DIR
MAP_FILE = BASE_DIR / "~temp" / "UNTRANSLATED_ENGLISH_TEXT_MAP.md"


def parse_map_file() -> Dict[str, List[str]]:
    """Parse MAP file to extract untranslated strings by namespace."""
    strings_by_namespace: Dict[str, List[str]] = {}

    with open(MAP_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    rows = re.findall(
        r'\|\s*([^|]+)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*([a-z_]+)\s*\|',
        content
    )

    for _, _, string_text, namespace in rows:
        string_text = string_text.strip().strip("`").strip('"').strip()

        if not string_text or not namespace:
            continue

        if namespace not in strings_by_namespace:
            strings_by_namespace[namespace] = []

        if string_text not in strings_by_namespace[namespace]:
            strings_by_namespace[namespace].append(string_text)

    return strings_by_namespace


def find_key_for_value(obj: Dict[str, Any], value: str, prefix: str = "") -> Optional[str]:
    """Recursively find JSON key for a given value (handles nested dicts)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and v == value:
                return prefix + ("." + k if prefix else k)
            elif isinstance(v, dict):
                result = find_key_for_value(v, value, prefix + ("." + k if prefix else k))
                if result:
                    return result
    return None


def get_nested_value(obj: Dict[str, Any], key_path: str) -> Optional[Any]:
    """Get value from nested dict using dot notation."""
    keys = key_path.split(".")
    current = obj
    for key in keys:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return None
    return current


def set_nested_value(obj: Dict[str, Any], key_path: str, value: Any) -> None:
    """Set value in nested dict using dot notation, creating dicts as needed."""
    keys = key_path.split(".")
    current = obj
    for key in keys[:-1]:
        if key not in current:
            current[key] = {}
        elif not isinstance(current[key], dict):
            return  # Can't nest further if value is not dict
        current = current[key]
    current[keys[-1]] = value


def build_string_to_key_map(namespace: str) -> Dict[str, str]:
    """Build map of English strings -> JSON keys for a namespace."""
    en_file = LOCALES_DIR / "en" / f"{namespace}.json"
    if not en_file.exists():
        return {}

    with open(en_file, "r", encoding="utf-8") as f:
        en_json = json.load(f)

    string_to_key: Dict[str, str] = {}

    def index_values(obj: Dict[str, Any], prefix: str = ""):
        if isinstance(obj, dict):
            for k, v in obj.items():
                key_path = prefix + ("." + k if prefix else k)
                if isinstance(v, str):
                    string_to_key[v] = key_path
                elif isinstance(v, dict):
                    index_values(v, key_path)

    index_values(en_json)
    return string_to_key


def translate_strings(
    client: anthropic.Anthropic,
    english_strings: Dict[str, List[str]],
    target_locale: str,
    cache_control_on_system: bool = False,
) -> Dict[str, Dict[str, str]]:
    """
    Translate English strings to target locale.
    Returns dict mapping namespace -> dict of {english_string: translated_string}.
    """

    english_json_str = json.dumps(english_strings, ensure_ascii=False, indent=2)

    system_prompt = f"""You are a professional translator. Translate UI strings from English to {LOCALE_NAMES[target_locale]}.

RULES:
1. Preserve JSON structure and template variables like {{{{count}}}}, {{{{name}}}}, etc.
2. Maintain tone, formality, and any special formatting
3. Return ONLY valid JSON with the same structure
4. Each value is a string to translate

English strings by namespace:

{english_json_str}

Translate all values to {LOCALE_NAMES[target_locale]}, keeping structure intact."""

    system_blocks = [{"type": "text", "text": system_prompt}]

    if cache_control_on_system:
        system_blocks[0]["cache_control"] = {"type": "ephemeral"}

    user_message = f"Translate these strings to {LOCALE_NAMES[target_locale]}. Return only the translated JSON with all namespaces."

    translated_strings: Dict[str, Dict[str, str]] = {}
    full_response = ""

    print(f"   Translating to {LOCALE_NAMES[target_locale]}...", end="", flush=True)

    with client.messages.stream(
        model="claude-opus-4-7",
        max_tokens=16000,
        system=system_blocks,
        messages=[{"role": "user", "content": user_message}],
    ) as stream:
        for text in stream.text_stream:
            full_response += text
            sys.stdout.write(".")
            sys.stdout.flush()

    print()  # newline

    try:
        json_match = re.search(r"\{[\s\S]*\}", full_response)
        if json_match:
            translated_strings = json.loads(json_match.group())
    except json.JSONDecodeError as e:
        print(f"     ERROR parsing JSON: {e}")
        return {}

    return translated_strings


def main():
    """Main execution flow."""
    print("=" * 70)
    print("ZAI-286: Batch Translation System (Approach 3 - Multi-call with Caching)")
    print("=" * 70)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    # Step 1: Parse untranslated strings
    print("\n1. PARSING UNTRANSLATED STRINGS")
    print("-" * 70)

    untranslated_by_namespace = parse_map_file()
    total_strings = sum(len(strs) for strs in untranslated_by_namespace.values())

    print(f"Found {total_strings} untranslated strings in {len(untranslated_by_namespace)} namespaces:")
    for ns in sorted(untranslated_by_namespace.keys()):
        count = len(untranslated_by_namespace[ns])
        print(f"  • {ns:12} — {count:3} strings")

    # Step 2: Build string-to-key mappings for each namespace
    print("\n2. BUILDING STRING-TO-KEY MAPPINGS")
    print("-" * 70)

    string_to_key_map: Dict[str, Dict[str, str]] = {}
    for namespace in untranslated_by_namespace.keys():
        string_to_key_map[namespace] = build_string_to_key_map(namespace)
        missing = [
            s for s in untranslated_by_namespace[namespace]
            if s not in string_to_key_map[namespace]
        ]
        if missing:
            print(f"  ⚠ {namespace}: {len(missing)} strings without keys in en/{namespace}.json")
        else:
            print(f"  ✓ {namespace}: all {len(untranslated_by_namespace[namespace])} strings mapped")

    # Step 3: Translate to each locale sequentially with cache reuse
    print("\n3. TRANSLATING TO LOCALES (with prompt caching)")
    print("-" * 70)

    for idx, locale in enumerate(LOCALES, 1):
        print(f"\n[{idx}/{len(LOCALES)}] {LOCALE_NAMES[locale]} ({locale})")

        try:
            translations = translate_strings(
                client,
                untranslated_by_namespace,
                locale,
                cache_control_on_system=(idx == 1),
            )

            if not translations:
                print(f"     ✗ No translations returned")
                continue

            # Merge translations into locale files
            for namespace, translated_keys in translations.items():
                if namespace not in untranslated_by_namespace:
                    continue

                locale_file = LOCALES_DIR / locale / f"{namespace}.json"
                locale_file.parent.mkdir(parents=True, exist_ok=True)

                # Load existing locale data
                if locale_file.exists():
                    with open(locale_file, "r", encoding="utf-8") as f:
                        locale_data = json.load(f)
                else:
                    locale_data = {}

                # Merge translations into locale data
                updated_count = 0
                for eng_str, trans_str in translated_keys.items():
                    if eng_str in string_to_key_map.get(namespace, {}):
                        key_path = string_to_key_map[namespace][eng_str]
                        set_nested_value(locale_data, key_path, trans_str)
                        updated_count += 1

                # Save updated locale file
                with open(locale_file, "w", encoding="utf-8") as f:
                    json.dump(locale_data, f, ensure_ascii=False, indent=2)

                print(f"     ✓ {namespace}: {updated_count} translations added/updated")

        except Exception as e:
            print(f"     ✗ ERROR: {e}")
            import traceback
            traceback.print_exc()
            continue

    print("\n" + "=" * 70)
    print("TRANSLATION COMPLETE")
    print("=" * 70)
    print("\nNext steps:")
    print("  1. Review translations in ui/src/locales/{locale}/ directories")
    print("  2. Run QA sweep to verify zero hardcoded English leaks")
    print("  3. Commit and push to vib-1171-2652-2760-3582-localization branch")


if __name__ == "__main__":
    main()
