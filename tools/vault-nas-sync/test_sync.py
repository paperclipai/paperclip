#!/usr/bin/env python3
"""Tests des Vault-Spiegels. Aufruf: python3 -m pytest test_sync.py -q

Geprueft wird gegen das echte Skript und echte Dateien in tmp_path — die NAS
wird nie angefasst. Der wichtigste Fall ist der letzte: ein Spiegel darf
Loeschungen nicht spurlos nachziehen, sonst ist er kein Backup.
"""
import os
import subprocess
from pathlib import Path

SKRIPT = Path(__file__).parent / "vault-nas-sync.sh"


def lauf(quelle, ziel, extra=()):
    r = subprocess.run(["/bin/bash", str(SKRIPT), "--quelle", str(quelle),
                        "--ziel", str(ziel), "--kein-versand", "--mindest", "2", "--pause", "0", *extra],
                       capture_output=True, text=True)
    return r


def baue_vault(w: Path):
    (w / "Tagesprotokolle").mkdir(parents=True)
    (w / "Tagesprotokolle" / "2026-08-22.md").write_text("heute")
    (w / "Analysen").mkdir()
    (w / "Analysen" / "notiz.md").write_text("inhalt")
    (w / ".obsidian").mkdir()
    (w / ".obsidian" / "workspace.json").write_text("{}")
    (w / ".trash").mkdir()
    (w / ".trash" / "geloescht.md").write_text("muell")
    (w / ".DS_Store").write_text("x")
    # Wiederherstellbarer Ballast, der im Vault tatsaechlich vorkommt
    (w / "projekte" / "code" / ".venv" / "lib").mkdir(parents=True)
    (w / "projekte" / "code" / ".venv" / "lib" / "riesig.bin").write_text("x" * 100)
    (w / "projekte" / "code" / "__pycache__").mkdir(parents=True)
    (w / "projekte" / "code" / "__pycache__" / "m.cpython-39.pyc").write_text("x")
    (w / "projekte" / "code" / "node_modules").mkdir()
    (w / "projekte" / "code" / "node_modules" / "paket.js").write_text("x")
    (w / "projekte" / "code" / ".git").mkdir()
    (w / "projekte" / "code" / ".git" / "config").write_text("historie")
    (w / "projekte" / "code" / "quelle.py").write_text("echter inhalt")
    return w


def test_inhalt_kommt_an(tmp_path):
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    assert lauf(q, z).returncode == 0
    assert (z / "Tagesprotokolle" / "2026-08-22.md").read_text() == "heute"
    assert (z / "Analysen" / "notiz.md").exists()


def test_muell_bleibt_draussen(tmp_path):
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    assert not (z / ".trash").exists()
    assert not (z / ".DS_Store").exists()
    assert not (z / ".obsidian" / "workspace.json").exists()


def test_aenderungen_werden_uebernommen(tmp_path):
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    (q / "Analysen" / "notiz.md").write_text("geaendert")
    lauf(q, z)
    assert (z / "Analysen" / "notiz.md").read_text() == "geaendert"


def test_geloeschtes_verschwindet_nicht_spurlos(tmp_path):
    """Der Kern. Ein Spiegel zieht Loeschungen nach — wird im Vault etwas
    geloescht oder verschluesselt, waere es beim naechsten Lauf auch auf der
    NAS weg. Deshalb landet Ersetztes und Geloeschtes in einem DATIERTEN
    Auffangordner, statt einfach zu verschwinden."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    (q / "Analysen" / "notiz.md").unlink()
    lauf(q, z)
    assert not (z / "Analysen" / "notiz.md").exists(), "Spiegel zieht nicht nach"
    treffer = list(z.parent.rglob("notiz.md"))
    aufgefangen = [p for p in treffer if "geloescht" in str(p)]
    assert aufgefangen, f"nicht aufgefangen; gefunden: {treffer}"


def test_ueberschriebenes_wird_aufgefangen(tmp_path):
    """Auch die ALTE Fassung einer geaenderten Datei muss erhalten bleiben —
    sonst hilft der Auffangordner gegen Verschluesselung nicht."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    (q / "Analysen" / "notiz.md").write_text("VERSCHLUESSELT")
    lauf(q, z)
    alt = [p for p in z.parent.rglob("notiz.md") if "geloescht" in str(p)]
    assert alt and alt[0].read_text() == "inhalt", \
        "alte Fassung nicht im Auffangordner"


def test_fehlende_quelle_bricht_ab_ohne_das_ziel_zu_leeren(tmp_path):
    """Der gefaehrlichste Fall ueberhaupt: ist der Vault nicht eingehaengt,
    wuerde ein blinder rsync --delete das Ziel leerraeumen."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    r = lauf(tmp_path / "gibtsnicht", z)
    assert r.returncode != 0
    assert (z / "Tagesprotokolle" / "2026-08-22.md").exists(), "Ziel geleert!"


def test_verdaechtig_leere_quelle_bricht_ab(tmp_path):
    """Ein vorhandener, aber (fast) leerer Quellordner ist genauso gefaehrlich
    wie ein fehlender — etwa wenn ein Mount ins Leere zeigt."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    leer = tmp_path / "leer"; leer.mkdir()
    r = lauf(leer, z)
    assert r.returncode != 0
    assert (z / "Tagesprotokolle" / "2026-08-22.md").exists(), "Ziel geleert!"


def test_apples_openrsync_wird_abgelehnt(tmp_path):
    """macOS liefert unter /usr/bin/rsync **openrsync** aus ("rsync version
    2.6.9 compatible"). Das ignoriert `--delete` zusammen mit `--backup-dir`
    STILLSCHWEIGEND — kein Fehler, kein Hinweis, es passiert einfach nichts.
    Der Spiegel haette dann nie etwas entfernt und nie etwas aufgefangen, und
    aufgefallen waere es erst bei der Wiederherstellung.

    Deshalb prueft das Skript beim Start, dass es echtes GNU rsync (>= 3) vor
    sich hat, statt sich auf den PATH zu verlassen."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    umg = dict(os.environ, RSYNC_BIN="/usr/bin/rsync")
    r = subprocess.run(["/bin/bash", str(SKRIPT), "--quelle", str(q),
                        "--ziel", str(z), "--kein-versand", "--mindest", "2",
                        "--pause", "0"],
                       capture_output=True, text=True, env=umg)
    assert r.returncode != 0
    assert "rsync" in (r.stdout + r.stderr).lower()


def test_fehlendes_rsync_bricht_ab(tmp_path):
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    umg = dict(os.environ, RSYNC_BIN="/gibt/es/nicht/rsync")
    r = subprocess.run(["/bin/bash", str(SKRIPT), "--quelle", str(q),
                        "--ziel", str(z), "--kein-versand", "--mindest", "2",
                        "--pause", "0"],
                       capture_output=True, text=True, env=umg)
    assert r.returncode != 0


def test_haengender_smb_wird_wiederholt_aber_nicht_endlos(tmp_path):
    """SMB reisst unter Last ab — der erste echte Lauf scheiterte am
    22.08.2026 mit „Input/output error" beim Schreiben von .git/index, beim
    naechsten Versuch ging es. Deshalb wiederholt das Skript.

    Es darf dabei aber nicht ewig kreisen: ein dauerhaft kaputtes Ziel muss
    zu einem Abbruch mit Fehlermeldung fuehren, nicht zu einem Job, der bis
    zum naechsten Morgen laeuft."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    stub = tmp_path / "rsync-kaputt"
    stub.write_text('#!/bin/bash\n[ "$1" = "--version" ] && { echo "rsync version 3.4.1"; exit 0; }\n'
                    'echo "Input/output error (5)" >&2\nexit 11\n')
    stub.chmod(0o755)
    umg = dict(os.environ, RSYNC_BIN=str(stub))
    import time
    t0 = time.time()
    r = subprocess.run(["/bin/bash", str(SKRIPT), "--quelle", str(q),
                        "--ziel", str(z), "--kein-versand", "--mindest", "2",
                        "--pause", "1"],
                       capture_output=True, text=True, env=umg, timeout=120)
    dauer = time.time() - t0
    assert r.returncode != 0, "haette abbrechen muessen"
    assert dauer < 90, f"zu lange gekreist: {dauer:.0f}s"
    assert "versuchen fehlgeschlagen" in (r.stdout + r.stderr).lower() or \
        "nicht gespiegelt" in (r.stdout + r.stderr).lower(), "keine Wiederholung erkennbar"


def test_geloeschter_ordner_bleibt_auf_der_nas_stehen(tmp_path):
    """Bewusste Eigenart der ordnerweisen Arbeitsweise, hier festgehalten
    damit sie niemanden ueberrascht:

    Das Skript arbeitet Ordner fuer Ordner, weil SMB bei 47.568 Dateien am
    Stueck zuverlaessig abreisst (gemessen 22.08.2026: monolithisch 650
    Schreibfehler, ordnerweise null). `--delete` wirkt dadurch INNERHALB
    jedes Ordners, aber ein im Vault komplett geloeschter Ordner der obersten
    Ebene bleibt auf der NAS stehen.

    Das ist die sichere Richtung: es bleibt zu viel erhalten, nie zu wenig."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    assert (z / "Analysen" / "notiz.md").exists()
    import shutil
    shutil.rmtree(q / "Analysen")
    lauf(q, z)
    assert (z / "Analysen").exists(), \
        "Ordner sollte stehenbleiben — siehe Docstring"


def test_loeschung_innerhalb_eines_ordners_wirkt(tmp_path):
    """Der haeufige Fall muss dagegen greifen."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    (q / "Analysen" / "zweite.md").write_text("weg damit")
    lauf(q, z)
    assert (z / "Analysen" / "zweite.md").exists()
    (q / "Analysen" / "zweite.md").unlink()
    lauf(q, z)
    assert not (z / "Analysen" / "zweite.md").exists()


def test_bei_fehlschlag_wird_der_ordner_feiner_aufgeteilt(tmp_path):
    """Am 22.08.2026 scheiterten zwei Ordner auch ordnerweise: `Katalog`
    (9.135 winzige Dateien) und `projekte` (9.322 Dateien, darunter eine mit
    572 MB). Bei hohen Dateizahlen reisst SMB weg — dieselbe Ursache wie beim
    monolithischen Lauf, nur eine Ebene tiefer.

    Antwort: scheitert ein Ordner, wird er in seine Unterordner zerlegt und
    diese werden einzeln versucht. Der Stub hier laesst genau den obersten
    Aufruf scheitern und alles Tiefere gelingen."""
    q = baue_vault(tmp_path / "vault")
    (q / "Gross" / "a").mkdir(parents=True)
    (q / "Gross" / "b").mkdir()
    (q / "Gross" / "a" / "eins.md").write_text("1")
    (q / "Gross" / "b" / "zwei.md").write_text("2")
    z = tmp_path / "nas"; z.mkdir()

    stub = tmp_path / "rsync-waehlerisch"
    stub.write_text(
        '#!/bin/bash\n'
        '[ "$1" = "--version" ] && { echo "rsync version 3.4.1"; exit 0; }\n'
        '# Der vorletzte Parameter ist die Quelle.\n'
        'for a in "$@"; do vor="$letzte"; letzte="$a"; done\n'
        'q="$vor"\n'
        'case "$q" in\n'
        '  */Gross) echo "rsync: [sender] write error: Broken pipe (32)" >&2; exit 12 ;;\n'
        'esac\n'
        'exec /opt/homebrew/bin/rsync "$@"\n')
    stub.chmod(0o755)
    umg = dict(os.environ, RSYNC_BIN=str(stub))
    r = subprocess.run(["/bin/bash", str(SKRIPT), "--quelle", str(q),
                        "--ziel", str(z), "--kein-versand", "--mindest", "2",
                        "--pause", "0"],
                       capture_output=True, text=True, env=umg, timeout=180)
    assert (z / "Gross" / "a" / "eins.md").exists(), \
        f"Unterordner nicht einzeln versucht.\n{r.stdout}\n{r.stderr}"
    assert (z / "Gross" / "b" / "zwei.md").exists()


def test_wiederherstellbarer_ballast_bleibt_draussen(tmp_path):
    """Der Vault enthaelt Code-Projekte: 2 `.venv` (0,7 GB, 8.097 Dateien,
    darunter ein 572-MB-spaCy-Modell), 433 `__pycache__` und `node_modules`.
    Zusammen ein Viertel aller Dateien — und alles aus Lockfiles wieder
    herstellbar. Genau daran scheiterte `projekte/obsidian` am 22.08.2026
    wieder und wieder."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    assert not (z / "projekte" / "code" / ".venv").exists()
    assert not (z / "projekte" / "code" / "__pycache__").exists()
    assert not (z / "projekte" / "code" / "node_modules").exists()
    assert (z / "projekte" / "code" / "quelle.py").exists(), "Quelltext fehlt!"


def test_git_historie_bleibt_erhalten(tmp_path):
    """`.git` ist KEIN Ballast: dort steckt die Historie, und die Projekte im
    Vault haben nicht zwangslaeufig ein Remote."""
    q = baue_vault(tmp_path / "vault"); z = tmp_path / "nas"; z.mkdir()
    lauf(q, z)
    assert (z / "projekte" / "code" / ".git" / "config").read_text() == "historie"
