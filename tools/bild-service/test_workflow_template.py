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


def test_prompt_containing_placeholder_text_survives():
    """Regression test: prompt with literal __SEED__, __WIDTH__ in text must survive unchanged."""
    raw = wt.load_raw("qwen-image")
    prompt_with_placeholders = "Ein Plakat mit den Woertern __SEED__ und __WIDTH__ als Text im Bild"
    wf = wt.fill(raw, prompt_with_placeholders, 42, 1024, 768)
    # The prompt must be unchanged in the text field
    assert wf["6"]["inputs"]["text"] == prompt_with_placeholders
    # But the actual numeric values must be correct in their fields
    assert wf["9"]["inputs"]["seed"] == 42
    assert wf["8"]["inputs"]["width"] == 1024
    assert wf["8"]["inputs"]["height"] == 768


def test_fill_escapes_comprehensive_special_chars():
    """Extended escaping test: quotes, newlines, backslashes, non-ASCII characters."""
    raw = wt.load_raw("qwen-image")
    # Include quote, newline, backslash, and non-ASCII characters
    prompt = r'Ein "Bild" mit Pfad C:\temp' + '\n' + "Café mit Grüßen"
    wf = wt.fill(raw, prompt, 1, 1024, 1024)
    # All special characters must survive verbatim
    assert wf["6"]["inputs"]["text"] == prompt


def test_qwen360_template_contains_all_placeholders():
    raw = wt.load_raw("qwen-360")
    for ph in wt.PLACEHOLDERS:
        assert ph in raw, "Platzhalter %s fehlt in der 360-Vorlage" % ph


def test_qwen360_fill_keeps_trigger_phrase():
    """Das Ausloesewort steht in der Vorlage, nicht im Auftrag -- sonst
    erzeugt ein Agent, der es vergisst, still ein flaches Bild."""
    wf = wt.fill(wt.load_raw("qwen-360"), "ein Studio", 5, 2048, 1024)
    text = wf["6"]["inputs"]["text"]
    assert "ein Studio" in text
    assert "equirectangular" in text


def test_qwen360_uses_dedicated_model_copies():
    """Eigene Dateikopien sind Pflicht: das Circular Padding wirkt inplace und
    wuerde sonst die zwischengespeicherten Modelle der normalen Auftraege
    veraendern (nachgewiesen: 1,8 % abweichende Pixel)."""
    wf = wt.fill(wt.load_raw("qwen-360"), "x", 1, 2048, 1024)
    assert wf["1"]["inputs"]["unet_name"].endswith("_360.safetensors")
    assert wf["3"]["inputs"]["vae_name"].endswith("_360.safetensors")
    normal = wt.fill(wt.load_raw("qwen-image"), "x", 1, 1024, 1024)
    assert not normal["1"]["inputs"]["unet_name"].endswith("_360.safetensors")


def test_qwen360_applies_circular_padding():
    wf = wt.fill(wt.load_raw("qwen-360"), "x", 1, 2048, 1024)
    kinds = {n["class_type"] for n in wf.values()}
    assert "Apply Circular Padding Model" in kinds
    assert "Apply Circular Padding VAE" in kinds
