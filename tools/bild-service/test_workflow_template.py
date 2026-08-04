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


def test_edit_vorlage_hat_bild_platzhalter():
    raw = wt.load_raw("qwen-edit")
    for ph in wt.IMAGE_PLACEHOLDERS:
        assert ph in raw
    assert "__PROMPT__" in raw and "__SEED__" in raw


def test_edit_vorlage_nutzt_das_edit_modell():
    """Zeigt die Vorlage auf das normale Modell, rendert sie still ein neues
    Bild statt das Quellbild zu bearbeiten."""
    wf = wt.fill(wt.load_raw("qwen-edit"), "x", 1)
    assert "edit" in wf["1"]["inputs"]["unet_name"]
    normal = wt.fill(wt.load_raw("qwen-image"), "x", 1, 1024, 1024)
    assert "edit" not in normal["1"]["inputs"]["unet_name"]


def test_set_images_mit_drei_bildern_setzt_alle():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1),
                       ["a.png", "b.png", "c.png"])
    assert wf["20"]["inputs"]["image"] == "a.png"
    assert wf["22"]["inputs"]["image"] == "b.png"
    assert wf["24"]["inputs"]["image"] == "c.png"
    assert "__IMAGE" not in json.dumps(wf)


def test_set_images_mit_einem_bild_entfernt_die_anderen():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png"])
    assert wf["20"]["inputs"]["image"] == "a.png"
    # Loader und Skalierer der ungenutzten Slots sind weg
    for tot in ("22", "23", "24", "25"):
        assert tot not in wf
    # und niemand verweist mehr auf sie
    assert "image2" not in wf["6"]["inputs"]
    assert "image3" not in wf["6"]["inputs"]
    assert "image2" not in wf["7"]["inputs"]
    assert "__IMAGE" not in json.dumps(wf)


def test_set_images_mit_zwei_bildern():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png", "b.png"])
    assert wf["20"]["inputs"]["image"] == "a.png"
    assert wf["22"]["inputs"]["image"] == "b.png"
    assert "24" not in wf and "25" not in wf
    assert wf["6"]["inputs"]["image2"] == ["23", 0]
    assert "image3" not in wf["6"]["inputs"]


def test_set_images_laesst_den_latent_pfad_stehen():
    """Die Ausgabegroesse haengt am VAEEncode des ersten Bildes -- faellt der
    weg, rendert der Sampler ins Leere."""
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png"])
    assert wf["8"]["inputs"]["pixels"] == ["21", 0]
    assert wf["9"]["inputs"]["latent_image"] == ["8", 0]


def test_set_images_ergebnis_bleibt_serialisierbar():
    wf = wt.set_images(wt.fill(wt.load_raw("qwen-edit"), "x", 1), ["a.png"])
    assert json.loads(json.dumps(wf)) == wf
