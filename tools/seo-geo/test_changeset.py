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


from changeset import validate_changeset

def test_validate_changeset_clean():
    cs = {"site":"x","changes":[
        {"target":"page","id":1,"field":"seo_title","old":None,"new":"Kurzer Titel"},
        {"target":"post","id":2,"field":"meta_description","old":None,"new":"d"*140},
    ]}
    assert validate_changeset(cs) == []

def test_validate_changeset_flags_length_violations():
    cs = {"site":"x","changes":[
        {"target":"post","id":474,"field":"seo_title","old":None,"new":"z"*71},
        {"target":"post","id":276,"field":"meta_description","old":None,"new":"d"*167},
    ]}
    p = validate_changeset(cs)
    assert len(p) == 2
    assert any("474" in x and "60" in x for x in p)
    assert any("276" in x and "160" in x for x in p)

def test_validate_changeset_flags_non_whitelisted_field():
    cs = {"site":"x","changes":[{"target":"post","id":1,"field":"body","old":None,"new":"x"}]}
    p = validate_changeset(cs)
    assert len(p) == 1 and "Whitelist" in p[0]

def test_validate_changeset_flags_bad_target_and_missing_id():
    cs = {"site":"x","changes":[
        {"target":"widget","id":1,"field":"seo_title","old":None,"new":"ok"},
        {"target":"post","id":None,"field":"seo_title","old":None,"new":"ok"},
    ]}
    p = validate_changeset(cs)
    assert any("target" in x for x in p)
    assert any("id fehlt" in x for x in p)
