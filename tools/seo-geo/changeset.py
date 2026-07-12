EDITABLE_FIELDS = {
    "seo_title", "meta_description", "og_title", "og_description",
    "canonical", "focus_keyword", "alt_text", "llms_txt",
}

def validate_change(change: dict) -> list[str]:
    warns: list[str] = []
    field, new = change.get("field"), change.get("new")
    if field == "seo_title" and isinstance(new, str) and len(new) > 60:
        warns.append(f"seo_title {len(new)} Zeichen > 60")
    if field == "meta_description" and isinstance(new, str) and not (120 <= len(new) <= 160):
        warns.append(f"meta_description {len(new)} Zeichen außerhalb 120–160")
    return warns

VALID_TARGETS = {"post", "page", "media", "site"}

def validate_changeset(changeset: dict) -> list[str]:
    """Deterministische Prüfung eines Changesets: Whitelist, target, id, Längen-Budgets.

    Leere Liste = sauber. Nimmt dem Agenten (und dem Lektor) das Zeichenzählen ab —
    was maschinell entscheidbar ist, entscheidet die Maschine.
    """
    problems: list[str] = []
    for i, c in enumerate(changeset.get("changes", []), 1):
        ref = f"#{i} id={c.get('id')}"
        fld = c.get("field")
        if fld not in EDITABLE_FIELDS:
            problems.append(f"{ref}: Feld '{fld}' nicht in Whitelist")
            continue
        if c.get("target") not in VALID_TARGETS:
            problems.append(f"{ref}: unbekanntes target '{c.get('target')}'")
        if c.get("target") != "site" and c.get("id") is None:
            problems.append(f"{ref}: id fehlt")
        for w in validate_change(c):
            problems.append(f"{ref}: {w}")
    return problems


def build_changeset(site_name: str, changes: list[dict]) -> dict:
    for c in changes:
        if c.get("field") not in EDITABLE_FIELDS:
            raise ValueError(f"Feld nicht in Whitelist: {c.get('field')}")
    return {"site": site_name, "changes": changes}
