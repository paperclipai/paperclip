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

def build_changeset(site_name: str, changes: list[dict]) -> dict:
    for c in changes:
        if c.get("field") not in EDITABLE_FIELDS:
            raise ValueError(f"Feld nicht in Whitelist: {c.get('field')}")
    return {"site": site_name, "changes": changes}
