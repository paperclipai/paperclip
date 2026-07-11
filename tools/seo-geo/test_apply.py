from apply import apply_changeset, ApplyLog

class FakeClient:
    def __init__(self):
        self.calls = []

    def set_yoast_meta(self, pid, field, value, post_type="posts"):
        self.calls.append(("yoast", pid, field, value, post_type))
        return {}

    def set_alt_text(self, mid, value):
        self.calls.append(("alt", mid, value))
        return {}

    def set_llms_txt(self, value):
        self.calls.append(("llms", value))
        return {}

CS = {
    "site": "x",
    "changes": [
        {"target": "post", "id": 1, "field": "seo_title", "old": "Alt", "new": "Neu"},
        {"target": "page", "id": 5, "field": "meta_description", "old": "Alte Beschreibung", "new": "Neue Beschreibung"},
        {"target": "media", "id": 7, "field": "alt_text", "old": "", "new": "Bild"},
        {"target": "site", "id": None, "field": "llms_txt", "old": "", "new": "# X\n"},
    ]
}

def test_apply_routes_and_logs():
    c = FakeClient()
    log = apply_changeset(CS, c)
    assert ("yoast", 1, "seo_title", "Neu", "posts") in c.calls
    assert ("yoast", 5, "meta_description", "Neue Beschreibung", "pages") in c.calls
    assert ("alt", 7, "Bild") in c.calls
    assert ("llms", "# X\n") in c.calls
    assert len(log.applied) == 4
    assert log.applied[0]["old"] == "Alt"
    assert log.applied[1]["old"] == "Alte Beschreibung"
    assert log.applied[1]["target"] == "page"

def test_dry_run_writes_nothing():
    c = FakeClient()
    log = apply_changeset(CS, c, dry_run=True)
    assert c.calls == []
    assert len(log.skipped) == 4
    # Verify all changes are in skipped with reason "dry-run"
    for skipped in log.skipped:
        assert skipped["reason"] == "dry-run"
