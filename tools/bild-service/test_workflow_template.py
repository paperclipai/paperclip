import json
import pytest
import workflow_template as wt


def test_template_contains_all_placeholders():
    raw = wt.load_raw("qwen-image")
    for ph in wt.PLACEHOLDERS:
        assert ph in raw, "Platzhalter %s fehlt in der Vorlage" % ph


def test_fill_leaves_no_placeholder():
    raw = wt.load_raw("qwen-image")
    wf = wt.fill(raw, "Ein Hirsch", 42, 1024, 1024)
    dumped = json.dumps(wf)
    for ph in wt.PLACEHOLDERS:
        assert ph not in dumped


def test_fill_produces_expected_values():
    raw = wt.load_raw("qwen-image")
    wf = wt.fill(raw, "Ein Hirsch", 7, 1536, 1024)
    assert wf["6"]["inputs"]["text"] == "Ein Hirsch"
    assert wf["9"]["inputs"]["seed"] == 7
    assert wf["8"]["inputs"]["width"] == 1536
    assert wf["8"]["inputs"]["height"] == 1024
    assert isinstance(wf["9"]["inputs"]["seed"], int)


def test_fill_escapes_quotes_in_prompt():
    raw = wt.load_raw("qwen-image")
    wf = wt.fill(raw, 'Ein "weisser" Hirsch\nzweite Zeile', 1, 1024, 1024)
    assert wf["6"]["inputs"]["text"] == 'Ein "weisser" Hirsch\nzweite Zeile'


def test_unknown_template_raises():
    with pytest.raises(FileNotFoundError):
        wt.load_raw("gibtsnicht")
