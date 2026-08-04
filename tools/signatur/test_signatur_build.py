from __future__ import annotations

import json
import os
import re

import pytest

import signatur_build

HIER = os.path.dirname(os.path.abspath(__file__))
KEYS = ["ai", "film", "tv", "academy", "app", "de"]


@pytest.fixture(scope="module")
def gebaut():
    return {k: signatur_build.baue(k) for k in KEYS}


def test_jede_signatur_hat_genau_einen_absender_platzhalter(gebaut):
    for k, html in gebaut.items():
        assert html.count("{{ABSENDERBLOCK}}") == 1, k


def test_keine_offenen_platzhalter_uebrig(gebaut):
    for k, html in gebaut.items():
        offen = set(re.findall(r"\{\{[A-Z_]+\}\}", html)) - {"{{ABSENDERBLOCK}}"}
        assert offen == set(), (k, offen)


def test_logo_ist_base64_eingebettet(gebaut):
    for k, html in gebaut.items():
        treffer = re.findall(r'src="data:image/png;base64,([A-Za-z0-9+/=]+)"', html)
        assert len(treffer) == 1, k
        assert len(treffer[0]) > 1000, k


def test_kontaktdaten_stammen_aus_den_bereichsdaten(gebaut):
    daten = json.load(open(os.path.join(HIER, "bereiche.json"), encoding="utf-8"))
    for k, html in gebaut.items():
        assert daten[k]["mail"] in html, k
        assert daten[k]["web"] in html, k


def test_feste_bestandteile_in_allen_bereichen(gebaut):
    for k, html in gebaut.items():
        assert "Beste Grüße" in html, k
        assert "Walter Schönenbröcher" in html, k
        assert "Inhaber" in html, k
        assert "Parzellenstr. 28" in html, k
        assert "WHITESTAG übernimmt keine Haftung" in html, k


def test_bereichszeile_nur_wo_im_original_vorhanden(gebaut):
    assert "WHITESTAG – Artificial Intelligence" in gebaut["ai"]
    assert "WHITESTAG – VR Filmproduktion" in gebaut["film"]
    assert "WHITESTAG – Television &amp; Broadcast" in gebaut["tv"]
    # academy, app und de tragen ihren Claim im Logo, nicht als Textzeile
    for k in ["academy", "app", "de"]:
        assert 'font-weight:bold;color:#111;">WHITESTAG' not in gebaut[k], k


def test_kaufmaennisches_und_ist_maskiert(gebaut):
    # "Television & Broadcast" muss als &amp; im HTML stehen, sonst brechen
    # strenge Mailclients das Markup auf.
    assert "Television &amp; Broadcast" in gebaut["tv"]


def test_sorbart_ist_kein_bereich_mehr():
    daten = json.load(open(os.path.join(HIER, "bereiche.json"), encoding="utf-8"))
    assert "sorbart" not in daten
    assert set(daten) == set(KEYS)


def test_unbekannter_bereich_wirft():
    with pytest.raises(KeyError):
        signatur_build.baue("gibtsnicht")


def test_main_schreibt_alle_sechs_dateien(tmp_path):
    assert signatur_build.main(str(tmp_path)) == 0
    for k in KEYS:
        assert (tmp_path / ("bereich-%s.html" % k)).exists(), k
