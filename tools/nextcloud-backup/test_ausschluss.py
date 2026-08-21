#!/usr/bin/env python3
"""Tests der Ausschlussliste. Aufruf: python3 -m pytest test_ausschluss.py -q

Warum das Tests braucht: die Ausschlussdatei entscheidet, was ausser Haus
gesichert wird. Ein zu weites Muster laedt 8 GB `node_modules` hoch, ein zu
enges laesst Quelltext zurueck — und beides merkt man erst, wenn man die
Sicherung braucht. Geprueft wird gegen restics echtes Verhalten, nicht gegen
eine Nachbildung der Musterlogik.
"""
import os
import subprocess
from pathlib import Path

import pytest

AUSSCHLUSS = Path(__file__).parent / "ausschluss-claude-code.txt"
RESTIC = "/opt/homebrew/bin/restic"


def restic_da():
    return Path(RESTIC).exists()


needs_restic = pytest.mark.skipif(not restic_da(), reason="restic nicht vorhanden")


def baue_baum(wurzel: Path):
    """Ein Miniaturabbild des echten Ordners."""
    dateien = [
        "Paperclip/server/src/app.ts",
        "Paperclip/server/src/lib/hilfe.ts",
        "Paperclip/tools/llm-usage/query.py",
        "Paperclip/docs/spec.md",
        "Paperclip/.git/config",
        "Paperclip/.git/objects/ab/cdef",
        "Paperclip/node_modules/react/index.js",
        "Paperclip/server/node_modules/express/index.js",
        "Paperclip/ui/dist/bundle.js",
        "Paperclip/server/venv/lib/python3.9/site.py",
        "Paperclip/tools/websuche/__pycache__/abruf.cpython-39.pyc",
        "Paperclip/.pytest_cache/v/cache/lastfailed",
        "Apps/WhisperBar-1.14.2.dmg",
        "ChatGPT Verlauf/2026-05-export.json",
        "Tagung Sorben/Programm.docx",
        ".DS_Store",
        "Paperclip/server/.DS_Store",
    ]
    for d in dateien:
        p = wurzel / d
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x")
    return wurzel


def gesichert(tmp_path):
    """Welche Pfade landen mit dieser Ausschlussliste tatsaechlich im Repo?"""
    quelle = baue_baum(tmp_path / "quelle")
    repo = tmp_path / "repo"
    umg = dict(os.environ, RESTIC_PASSWORD="test", RESTIC_REPOSITORY=str(repo))
    subprocess.run([RESTIC, "init"], env=umg, capture_output=True, check=True)
    subprocess.run([RESTIC, "backup", str(quelle),
                    "--exclude-file", str(AUSSCHLUSS)],
                   env=umg, capture_output=True, check=True)
    r = subprocess.run([RESTIC, "ls", "latest"], env=umg,
                       capture_output=True, text=True, check=True)
    prefix = str(quelle)
    return {z[len(prefix):].lstrip("/") for z in r.stdout.splitlines()
            if z.startswith(prefix) and not z.endswith(prefix)}


@needs_restic
def test_quelltext_wird_gesichert(tmp_path):
    drin = gesichert(tmp_path)
    for pfad in ("Paperclip/server/src/app.ts",
                 "Paperclip/tools/llm-usage/query.py",
                 "Paperclip/docs/spec.md"):
        assert pfad in drin, f"{pfad} fehlt!"


@needs_restic
def test_git_historie_wird_gesichert(tmp_path):
    """Die .git-Verzeichnisse sind der wertvollste Teil — dort steckt die
    Historie, die auf keinem Fernserver liegt (viele Ordner sind gar keine
    Repos oder haben kein Remote)."""
    drin = gesichert(tmp_path)
    assert "Paperclip/.git/config" in drin
    assert "Paperclip/.git/objects/ab/cdef" in drin


@needs_restic
def test_wiederherstellbarer_ballast_fliegt_raus(tmp_path):
    drin = gesichert(tmp_path)
    for pfad in ("Paperclip/node_modules/react/index.js",
                 "Paperclip/server/node_modules/express/index.js",
                 "Paperclip/ui/dist/bundle.js",
                 "Paperclip/server/venv/lib/python3.9/site.py",
                 "Paperclip/tools/websuche/__pycache__/abruf.cpython-39.pyc",
                 "Paperclip/.pytest_cache/v/cache/lastfailed"):
        assert pfad not in drin, f"{pfad} haette ausgeschlossen sein muessen!"


@needs_restic
def test_node_modules_auch_in_der_tiefe(tmp_path):
    """Nicht nur im Wurzelverzeichnis — sie liegen ueber den Baum verstreut."""
    drin = gesichert(tmp_path)
    assert not any("node_modules" in p for p in drin), \
        [p for p in drin if "node_modules" in p]


@needs_restic
def test_dokumente_und_verlaeufe_bleiben(tmp_path):
    """Das ist echter Inhalt, kein Ballast."""
    drin = gesichert(tmp_path)
    assert "ChatGPT Verlauf/2026-05-export.json" in drin
    assert "Tagung Sorben/Programm.docx" in drin


@needs_restic
def test_ds_store_fliegt_raus(tmp_path):
    drin = gesichert(tmp_path)
    assert not any(p.endswith(".DS_Store") for p in drin)
