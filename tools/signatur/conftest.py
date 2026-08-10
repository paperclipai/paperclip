# conftest.py
"""bereich-*.html sind abgeleitet und gitignored (siehe .gitignore). Ein
frischer Checkout hat sie darum nicht -- ohne diesen Hook wuerden
test_signatur.py, test_signatur_build.py und test_cross_impl_signatur.py mit
FileNotFoundError scheitern, bevor ueberhaupt ein einziger Test laeuft.

Erzeugt sie bei Bedarf einmal vor der Testsammlung ueber signatur_build.py
(dieselbe Funktion, die auch deploy.sh nutzt) und committet sie NICHT --
die .gitignore-Regel bleibt unveraendert."""
from __future__ import annotations

import os

HIER = os.path.dirname(os.path.abspath(__file__))
KEYS = ["ai", "film", "tv", "academy", "app", "de"]


def _bausteine_fehlen() -> bool:
    return any(
        not os.path.exists(os.path.join(HIER, "bereich-%s.html" % k))
        for k in KEYS
    )


def pytest_configure(config):  # noqa: ARG001 — pytest-Hook-Signatur
    if _bausteine_fehlen():
        import signatur_build
        signatur_build.main(HIER)
