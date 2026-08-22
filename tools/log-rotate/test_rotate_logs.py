import os

import rotate_logs


def _fill(path, size):
    with open(path, "wb") as f:
        f.write(b"x" * size)


def test_kleine_datei_bleibt_unberuehrt(tmp_path):
    p = tmp_path / "klein.log"
    _fill(str(p), 100)
    assert rotate_logs.rotate(str(p), max_bytes=1000, keep_bytes=100) is False
    assert p.stat().st_size == 100
    assert not (tmp_path / "klein.log.1").exists()


def test_grosse_datei_wird_geleert(tmp_path):
    p = tmp_path / "gross.log"
    _fill(str(p), 5000)
    assert rotate_logs.rotate(str(p), max_bytes=1000, keep_bytes=100) is True
    assert p.stat().st_size == 0


def test_der_juengste_teil_bleibt_erhalten(tmp_path):
    """Nicht der Anfang, sondern das ENDE ist beim Debuggen interessant."""
    p = tmp_path / "gross.log"
    with open(str(p), "wb") as f:
        f.write(b"a" * 5000 + b"ENDE")
    rotate_logs.rotate(str(p), max_bytes=1000, keep_bytes=100)
    archiv = (tmp_path / "gross.log.1").read_bytes()
    assert archiv.endswith(b"ENDE")
    assert len(archiv) == 100


def test_schreiber_mit_offenem_fd_schreibt_korrekt_weiter(tmp_path):
    """Der eigentliche Fallstrick: launchd (StandardOutPath) und pino halten
    die Datei dauerhaft offen. Ein os.replace() waere fuer sie unsichtbar --
    sie schrieben weiter in die umbenannte Datei, und das neue Log bliebe bis
    zum Neustart leer. Deshalb MUSS in place gekuerzt werden."""
    p = tmp_path / "offen.log"
    schreiber = open(str(p), "a")           # 'a' == O_APPEND, wie launchd und pino
    try:
        schreiber.write("alt\n" * 2000)
        schreiber.flush()

        rotate_logs.rotate(str(p), max_bytes=1000, keep_bytes=100)

        schreiber.write("neu\n")
        schreiber.flush()
    finally:
        schreiber.close()

    inhalt = p.read_bytes()
    assert inhalt == b"neu\n"               # kein Loch, kein Rueckwachsen auf alte Groesse
    assert p.stat().st_size == 4


def test_fehlende_datei_ist_kein_fehler(tmp_path):
    assert rotate_logs.rotate(str(tmp_path / "gibtsnicht.log")) is False


def test_archiv_wird_bei_der_naechsten_rotation_ersetzt(tmp_path):
    """Es bleibt bei genau EINER Archivgeneration -- sonst waere das
    Platzproblem nur verschoben."""
    p = tmp_path / "gross.log"
    with open(str(p), "wb") as f:
        f.write(b"a" * 5000 + b"ERSTE")
    rotate_logs.rotate(str(p), max_bytes=1000, keep_bytes=100)
    with open(str(p), "wb") as f:
        f.write(b"b" * 5000 + b"ZWEITE")
    rotate_logs.rotate(str(p), max_bytes=1000, keep_bytes=100)

    assert (tmp_path / "gross.log.1").read_bytes().endswith(b"ZWEITE")
    assert not (tmp_path / "gross.log.2").exists()


def test_archiv_selbst_wird_nicht_rotiert(tmp_path):
    """Sonst frisst sich die Rotation durch ihre eigenen Archive."""
    logs = tmp_path / "logs"
    logs.mkdir()
    _fill(str(logs / "a.log"), 5000)
    _fill(str(logs / "a.log.1"), 5000)

    rotiert = rotate_logs.rotate_dir(str(logs), max_bytes=1000, keep_bytes=100)

    assert rotiert == [str(logs / "a.log")]
    assert (logs / "a.log.1").stat().st_size == 100      # neu geschrieben, nicht selbst rotiert
    assert not (logs / "a.log.1.1").exists()


def test_rotate_dir_nimmt_alle_logs_im_ordner(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    _fill(str(logs / "a.log"), 5000)
    _fill(str(logs / "b.log"), 5000)
    _fill(str(logs / "c.log"), 10)
    _fill(str(logs / "keine-logdatei.txt"), 5000)

    rotiert = rotate_logs.rotate_dir(str(logs), max_bytes=1000, keep_bytes=100)

    assert sorted(rotiert) == [str(logs / "a.log"), str(logs / "b.log")]
    assert (logs / "keine-logdatei.txt").stat().st_size == 5000


def test_fehlender_ordner_ist_kein_fehler(tmp_path):
    assert rotate_logs.rotate_dir(str(tmp_path / "gibtsnicht")) == []


def test_archiv_landet_neben_der_datei(tmp_path):
    p = tmp_path / "gross.log"
    _fill(str(p), 5000)
    rotate_logs.rotate(str(p), max_bytes=1000, keep_bytes=100)
    assert os.path.exists(str(tmp_path / "gross.log.1"))
