"""Tests der Integritaetspruefung. Aufruf: python3 -m pytest test_pruefe_repo.py -q

Geprueft wird gegen ECHTE restic-Repos in tmp_path — das Repo bei Hetzner wird
nie angefasst. Der wichtigste Test ist `test_gekippte_bits_werden_gefunden`:
genau dafuer gibt es das Skript, und genau das kann `restic check` ohne
`--read-data-subset` NICHT.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SKRIPT = Path(__file__).parent / "pruefe-repo.sh"
RESTIC = "/opt/homebrew/bin/restic"

pytestmark = pytest.mark.skipif(not Path(RESTIC).exists(),
                                reason="restic nicht installiert")


@pytest.fixture(autouse=True)
def kein_produktivlog(monkeypatch):
    monkeypatch.setenv("PRUEF_STILL", "1")


def baue_repo(tmp_path):
    """Ein kleines, aber echtes restic-Repo mit einem Snapshot."""
    repo = tmp_path / "repo"
    passwort = tmp_path / "pass"
    passwort.write_text("test")
    umgebung = {**os.environ,
                "RESTIC_REPOSITORY": str(repo),
                "RESTIC_PASSWORD_FILE": str(passwort)}
    subprocess.run([RESTIC, "init"], env=umgebung, check=True,
                   capture_output=True)
    quelle = tmp_path / "daten"
    quelle.mkdir()
    # Gross genug, dass restic eine eigene Pack-Datei anlegt, die sich
    # anschliessend gezielt beschaedigen laesst.
    for i in range(5):
        (quelle / f"datei{i}.txt").write_text(f"Inhalt {i} " + "x" * 200_000)
    subprocess.run([RESTIC, "backup", str(quelle)], env=umgebung, check=True,
                   capture_output=True)
    return repo, passwort, umgebung


def lauf(repo, passwort, tmp_path, extra=()):
    return subprocess.run(
        ["/bin/bash", str(SKRIPT), "--kein-versand", "--repo", str(repo), *extra],
        capture_output=True, text=True,
        env={**os.environ,
             "RESTIC_PASSWORD_FILE": str(passwort),
             "PRUEF_STILL": "1",
             "HOME": str(tmp_path)})       # Log/Status landen in tmp_path


def status(tmp_path):
    p = tmp_path / ".paperclip" / "logs" / "repo-pruefung-last.json"
    return json.loads(p.read_text()) if p.exists() else None


# --- Der gute Fall ---------------------------------------------------------

def test_heiles_repo_wird_bestaetigt(tmp_path):
    repo, passwort, _ = baue_repo(tmp_path)
    r = lauf(repo, passwort, tmp_path, extra=("--anteil", "1/1"))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Repo unversehrt" in r.stdout
    assert status(tmp_path)["stand"] == "ok"


def test_status_haelt_den_geprueften_abschnitt_fest(tmp_path):
    """Der Waechter soll spaeter sehen koennen, WAS geprueft wurde — sonst
    laesst sich nicht sagen, ob die Rotation ueberhaupt vorankommt."""
    repo, passwort, _ = baue_repo(tmp_path)
    lauf(repo, passwort, tmp_path, extra=("--anteil", "3/12"))
    assert status(tmp_path)["anteil"] == "3/12"


def test_nur_struktur_ueberspringt_das_lesen(tmp_path):
    repo, passwort, _ = baue_repo(tmp_path)
    r = lauf(repo, passwort, tmp_path, extra=("--nur-struktur",))
    assert r.returncode == 0
    assert "Struktur in Ordnung" in r.stdout
    assert "Datenabschnitt" not in r.stdout
    assert status(tmp_path)["anteil"] == "uebersprungen"


# --- Die Faelle, wegen derer es das Skript gibt ----------------------------

def test_gekippte_bits_werden_gefunden(tmp_path):
    """Stille Korruption: Datei gleich lang, Inhalt verfaelscht.

    Das ist der Schaden, den die taegliche Sicherung und der Waechter beide
    NICHT sehen — beide bleiben gruen, waehrend das Repo unbrauchbar wird.
    """
    repo, passwort, _ = baue_repo(tmp_path)
    packs = list((repo / "data").rglob("*"))
    packs = [p for p in packs if p.is_file()]
    assert packs, "kein Pack gefunden — Testaufbau stimmt nicht"
    opfer = max(packs, key=lambda p: p.stat().st_size)
    roh = bytearray(opfer.read_bytes())
    mitte = len(roh) // 2
    roh[mitte] ^= 0xFF                      # ein einziges gekipptes Byte
    # restic legt Packs schreibgeschuetzt (0444) an — genau deshalb ist ein
    # Bitfehler hier auch kein Versehen, sondern Alterung des Datentraegers.
    opfer.chmod(0o644)
    opfer.write_bytes(bytes(roh))

    r = lauf(repo, passwort, tmp_path, extra=("--anteil", "1/1"))
    assert r.returncode != 0, "beschaedigtes Repo wurde als heil gemeldet"
    assert status(tmp_path)["stand"] == "fehler"


def test_fehlendes_pack_wird_gefunden(tmp_path):
    """Grober Schaden — den findet schon die Strukturpruefung."""
    repo, passwort, _ = baue_repo(tmp_path)
    packs = [p for p in (repo / "data").rglob("*") if p.is_file()]
    max(packs, key=lambda p: p.stat().st_size).unlink()
    r = lauf(repo, passwort, tmp_path, extra=("--nur-struktur",))
    assert r.returncode != 0
    assert status(tmp_path)["stand"] == "fehler"


def test_unerreichbares_repo_ist_ein_fehler(tmp_path):
    """Kein Zugang heisst NICHT „alles gut" — dieselbe Regel wie in
    pruefung.bewerte: fehlende Auskunft ist ein Problem, kein Freibrief."""
    passwort = tmp_path / "pass"
    passwort.write_text("test")
    r = lauf(tmp_path / "gibt-es-nicht", passwort, tmp_path)
    assert r.returncode != 0
    assert status(tmp_path)["stand"] == "fehler"


def test_fehlendes_restic_bricht_ab(tmp_path):
    repo, passwort, _ = baue_repo(tmp_path)
    r = subprocess.run(
        ["/bin/bash", str(SKRIPT), "--kein-versand", "--repo", str(repo)],
        capture_output=True, text=True,
        env={**os.environ, "RESTIC_BIN": "/gibt/es/nicht/restic",
             "RESTIC_PASSWORD_FILE": str(passwort),
             "PRUEF_STILL": "1", "HOME": str(tmp_path)})
    assert r.returncode != 0
    assert "restic nicht gefunden" in r.stdout


# --- Die Monatsrotation ----------------------------------------------------

@pytest.mark.parametrize("monat", [f"{m:02d}" for m in range(1, 13)])
def test_monatszahl_wird_dezimal_gelesen(monat):
    """`$((08))` ist in bash ein Syntaxfehler (ungueltige Oktalzahl).

    Ohne das `10#` im Skript waere die Pruefung in JEDEM August und September
    kommentarlos gestorben — also genau dann, wenn niemand hinsieht.
    """
    r = subprocess.run(["/bin/bash", "-c", f'echo "$((10#{monat}))/12"'],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == f"{int(monat)}/12"


def test_jeder_monat_trifft_einen_eigenen_abschnitt():
    """Zwoelf Monate, zwoelf verschiedene Abschnitte — sonst blieben Teile
    des Repos auf Dauer ungelesen."""
    abschnitte = {subprocess.run(
        ["/bin/bash", "-c", f'echo "$((10#{m:02d}))/12"'],
        capture_output=True, text=True).stdout.strip() for m in range(1, 13)}
    assert len(abschnitte) == 12
