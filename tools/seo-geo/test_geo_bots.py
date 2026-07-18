import datetime
from geo_bots import current_week_hits, iso_week


def test_iso_week_format():
    assert iso_week(datetime.date(2026, 7, 18)) == "2026-W29"


def test_current_week_hits_vorhanden():
    data = {"2026-W29": {"GPTBot": 12, "ClaudeBot": 3}, "2026-W28": {"GPTBot": 5}}
    assert current_week_hits(data, "2026-W29") == {"GPTBot": 12, "ClaudeBot": 3}


def test_current_week_hits_fehlt_leer():
    assert current_week_hits({"2026-W28": {"GPTBot": 5}}, "2026-W29") == {}
