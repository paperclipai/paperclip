from __future__ import annotations

import os

from PIL import Image

LOGODIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logos")
KEYS = ["ai", "film", "tv", "academy", "app", "de"]
MAX_BYTES = 60 * 1024


def test_alle_sechs_logos_vorhanden():
    fehlend = [k for k in KEYS if not os.path.exists(os.path.join(LOGODIR, k + ".png"))]
    assert fehlend == []


def test_logos_sind_250px_breit():
    for k in KEYS:
        with Image.open(os.path.join(LOGODIR, k + ".png")) as im:
            assert im.width == 250, k


def test_logos_unter_budget():
    zu_gross = [
        k for k in KEYS
        if os.path.getsize(os.path.join(LOGODIR, k + ".png")) > MAX_BYTES
    ]
    assert zu_gross == []


def test_logos_haben_transparenz():
    # Die Signaturen stehen auf weissem Mailgrund; ein verlorener Alphakanal
    # faellt erst beim Empfaenger auf.
    for k in KEYS:
        with Image.open(os.path.join(LOGODIR, k + ".png")) as im:
            assert im.mode in ("RGBA", "P"), k
