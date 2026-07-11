import pytest
from changeset import EDITABLE_FIELDS, validate_change, build_changeset

def test_editable_fields_are_locked():
    assert EDITABLE_FIELDS == {
        "seo_title", "meta_description", "og_title", "og_description",
        "canonical", "focus_keyword", "alt_text", "llms_txt"}

def test_build_rejects_non_whitelisted_field():
    with pytest.raises(ValueError):
        build_changeset("x", [{"target":"post","id":1,"field":"body","old":"a","new":"b"}])

def test_build_accepts_whitelisted_change():
    cs = build_changeset("x", [{"target":"post","id":1,"field":"seo_title",
                                "old":None,"new":"Neuer Titel"}])
    assert cs["site"] == "x"
    assert cs["changes"][0]["field"] == "seo_title"

def test_validate_flags_length_budget():
    warns = validate_change({"target":"post","id":1,"field":"seo_title",
                             "old":None,"new":"z"*70})
    assert any("60" in w for w in warns)
