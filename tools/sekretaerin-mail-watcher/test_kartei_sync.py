from __future__ import annotations

import kartei_sync as ks


def test_postfach_bereich_ai():
    assert ks._postfach_bereich("empfang@whitestag.ai") == "AI"


def test_postfach_bereich_film():
    assert ks._postfach_bereich("empfang@whitestag.film") == "FILM"


def test_postfach_bereich_sorbart_de_liefert_none():
    # sorbART stillgelegt (08/2026) -- kein Bereich mehr, Luna fragt nach.
    assert ks._postfach_bereich("info@sorbart.de") is None


def test_postfach_bereich_sorbart_shop_liefert_none():
    assert ks._postfach_bereich("shop@sorbart.shop") is None


def test_postfach_bereich_unbekannt_liefert_none():
    assert ks._postfach_bereich("info@irgendwas.de") is None


def test_valid_enthaelt_kein_sorbart():
    assert ks.VALID == {"AI", "FILM", "PRIVAT"}


def test_bereich_from_body_erkennt_ai(tmp_path):
    p = tmp_path / "mail.md"
    p.write_text("---\nvon: x\n---\nDer Bereich ist AI.\n", encoding="utf-8")
    assert ks._bereich_from_body(p) == "AI"


def test_bereich_from_body_erkennt_film(tmp_path):
    p = tmp_path / "mail.md"
    p.write_text("---\nvon: x\n---\nBitte FILM zuordnen.\n", encoding="utf-8")
    assert ks._bereich_from_body(p) == "FILM"


def test_bereich_from_body_erkennt_privat(tmp_path):
    p = tmp_path / "mail.md"
    p.write_text("---\nvon: x\n---\nDas ist PRIVAT.\n", encoding="utf-8")
    assert ks._bereich_from_body(p) == "PRIVAT"


def test_bereich_from_body_erkennt_sorbart_nicht_mehr(tmp_path):
    p = tmp_path / "mail.md"
    p.write_text("---\nvon: x\n---\nDas war frueher SORBART.\n", encoding="utf-8")
    assert ks._bereich_from_body(p) is None
