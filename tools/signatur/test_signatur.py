from __future__ import annotations

import pytest

import signatur


def test_absenderblock_enthaelt_name_rolle_und_hinweis():
    block = signatur.absenderblock("CTO", "KI-Agent", "Automatisch erstellt.")
    assert "i.A. CTO" in block
    assert "KI-Agent" in block
    assert "Automatisch erstellt." in block


def test_absenderblock_maskiert_html():
    block = signatur.absenderblock("A<b>B", "R&D", "x<y")
    assert "<b>" not in block
    assert "A&lt;b&gt;B" in block
    assert "R&amp;D" in block
    assert "x&lt;y" in block


def test_komponiere_ersetzt_den_platzhalter():
    html = signatur.komponiere("ai", "<div>BLOCK</div>")
    assert "{{ABSENDERBLOCK}}" not in html
    assert "<div>BLOCK</div>" in html
    assert "ws@whitestag.ai" in html


def test_komponiere_kennt_alle_sechs_bereiche():
    assert len(signatur.BEREICHE) == 6
    for k in signatur.BEREICHE:
        assert "{{ABSENDERBLOCK}}" not in signatur.komponiere(k, "<i>x</i>")


def test_sorbart_ist_kein_bereich_mehr():
    assert "sorbart" not in signatur.BEREICHE
    with pytest.raises(ValueError):
        signatur.komponiere("sorbart", "<i>x</i>")


def test_komponiere_wirft_bei_unbekanntem_bereich():
    with pytest.raises(ValueError):
        signatur.komponiere("gibtsnicht", "<i>x</i>")


def test_zu_cid_ersetzt_base64_durch_cid_referenz():
    html, anhaenge = signatur.zu_cid(signatur.komponiere("ai", "<i>x</i>"))
    assert "data:image/png;base64," not in html
    assert 'src="cid:attachment_0"' in html
    assert len(anhaenge) == 1
    assert anhaenge[0]["cid"] == "attachment_0"
    assert anhaenge[0]["mimeType"] == "image/png"
    assert len(anhaenge[0]["content"]) > 1000


def test_zu_cid_beachtet_den_startindex():
    """Der kritische Fall: die Mail bringt bereits Anhaenge mit."""
    html, anhaenge = signatur.zu_cid(
        signatur.komponiere("ai", "<i>x</i>"), ab_index=3
    )
    assert 'src="cid:attachment_3"' in html
    assert anhaenge[0]["cid"] == "attachment_3"


def test_zu_cid_ohne_bild_bleibt_unveraendert():
    html, anhaenge = signatur.zu_cid("<p>kein Bild</p>")
    assert html == "<p>kein Bild</p>"
    assert anhaenge == []


def test_zu_cid_ignoriert_data_src_falsch_positiv():
    """Sichert: data-src wird nicht mit src verwechselt."""
    html = '<img src="tiny.gif" data-src="data:image/png;base64,AAAA">'
    result_html, anhaenge = signatur.zu_cid(html)
    # data-src endet zwar auf 'src', ist aber nicht das src-Attribut
    # Sollte nicht erkannt und nicht in Anhänge konvertiert werden
    assert result_html == html
    assert anhaenge == []
    # Normales src= wird trotzdem erkannt
    normal_html = '<img src="data:image/png;base64,AAAA">'
    result_normal, anhaenge_normal = signatur.zu_cid(normal_html)
    assert 'src="cid:attachment_0"' in result_normal
    assert len(anhaenge_normal) == 1


def test_zu_cid_verarbeitet_mehrere_eingebettete_bilder():
    """Mehrere base64-Bilder in einem Aufruf bekommen fortlaufende CIDs."""
    # Zwei Bilder in einer HTML-Zeichenkette
    html = (
        '<img src="data:image/png;base64,AAAA">'
        '<img src="data:image/png;base64,BBBB">'
    )
    result_html, anhaenge = signatur.zu_cid(html)

    # Zwei Anhänge mit fortlaufenden Indices
    assert len(anhaenge) == 2
    assert anhaenge[0]["cid"] == "attachment_0"
    assert anhaenge[1]["cid"] == "attachment_1"

    # Unterschiedliche Dateinamen
    assert anhaenge[0]["filename"] == "logo-0.png"
    assert anhaenge[1]["filename"] == "logo-1.png"

    # Beide unterschiedliche base64-Inhalte
    assert anhaenge[0]["content"] == "AAAA"
    assert anhaenge[1]["content"] == "BBBB"

    # Beide CID-Referenzen im HTML
    assert 'src="cid:attachment_0"' in result_html
    assert 'src="cid:attachment_1"' in result_html

    # Kein base64 mehr übrig
    assert "data:image/png;base64," not in result_html


def test_zu_cid_mehrere_bilder_mit_startindex():
    """Mehrere Bilder mit ab_index berechnen korrekte fortlaufende Indices."""
    # Zwei Bilder, Mail bringt bereits 2 Anhänge mit (ab_index=2)
    html = (
        '<img src="data:image/png;base64,XXXX">'
        '<img src="data:image/png;base64,YYYY">'
    )
    result_html, anhaenge = signatur.zu_cid(html, ab_index=2)

    # Zwei Anhänge mit Indices ab 2
    assert len(anhaenge) == 2
    assert anhaenge[0]["cid"] == "attachment_2"
    assert anhaenge[1]["cid"] == "attachment_3"

    # Dateinamen spiegeln den Index
    assert anhaenge[0]["filename"] == "logo-2.png"
    assert anhaenge[1]["filename"] == "logo-3.png"

    # Beide CID-Referenzen im HTML
    assert 'src="cid:attachment_2"' in result_html
    assert 'src="cid:attachment_3"' in result_html

    # Kein base64 mehr übrig
    assert "data:image/png;base64," not in result_html


def test_vorgabe_bereich_ist_ai():
    assert signatur.VORGABE_BEREICH == "ai"
