from __future__ import annotations

import pytest

import luna_mail_render as lmr


def test_nur_noch_ai_und_film():
    assert set(lmr.AREAS) == {"AI", "FILM"}


def test_sorbart_wird_abgewiesen():
    with pytest.raises(KeyError):
        lmr.load_sig("SORBART")


def test_load_sig_liefert_lunas_absenderblock():
    for area in ["AI", "FILM"]:
        sig = lmr.load_sig(area)
        assert "i.A. Luna" in sig, area
        assert "KI-Assistentin" in sig, area
        assert "{{ABSENDERBLOCK}}" not in sig, area


def test_luna_hinweiszeile_nennt_walters_freigabe():
    # Bei Luna trifft das zu — die Vier-Augen-Freigabe haengt davor.
    assert "geprüft und freigegeben" in lmr.load_sig("AI")


def test_bereichsdaten_passen_zum_area_key():
    assert "ws@whitestag.ai" in lmr.load_sig("AI")
    assert "ws@whitestag.film" in lmr.load_sig("FILM")


def test_unbekannter_area_wirft():
    with pytest.raises(KeyError):
        lmr.load_sig("GIBTSNICHT")


def test_render_customer_html_liefert_cid_und_anhang():
    html, anhaenge = lmr.render_customer_html("AI", "Guten Tag\n\nDanke.")
    assert "data:image/png;base64," not in html
    assert 'src="cid:attachment_0"' in html
    assert len(anhaenge) == 1
    assert anhaenge[0]["cid"] == "attachment_0"


def test_render_customer_html_schneidet_eigene_grussformel_ab():
    html, _ = lmr.render_customer_html(
        "AI", "Guten Tag\n\nDanke.\n\nViele Grüße\nLuna\nirgendein Disclaimer"
    )
    assert "irgendein Disclaimer" not in html


def test_signatur_kommt_nach_dem_antworttext():
    html, _ = lmr.render_customer_html("AI", "Antworttext hier.")
    assert html.index("Antworttext hier.") < html.index("i.A. Luna")
