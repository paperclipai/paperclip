import json, os
import seo_approvals as sa

def test_create_and_load(tmp_path):
    tok = sa.create(str(tmp_path), "whitestag.film",
                    "/p/cs-resolved.json", "/p/list.txt",
                    count=79, alt_count=8, chat_id=8311805232,
                    token="TESTTOK", now=1000.0)
    assert tok == "TESTTOK"
    rec = sa.load(str(tmp_path), "TESTTOK")
    assert rec["site"] == "whitestag.film"
    assert rec["status"] == "pending"
    assert rec["count"] == 79
    assert rec["created"] == 1000.0

def test_set_status_and_note(tmp_path):
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="T", now=1.0)
    sa.set_status(str(tmp_path), "T", "rejected", note="zu lang")
    rec = sa.load(str(tmp_path), "T")
    assert rec["status"] == "rejected"
    assert rec["note"] == "zu lang"

def test_list_pending_older_than(tmp_path):
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="OLD", now=0.0)
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="NEW", now=100000.0)
    # 24h = 86400s; bei now=100000 ist OLD >24h, NEW nicht
    pend = sa.list_pending(str(tmp_path), older_than_hours=24, now=100000.0)
    toks = {p["token"] for p in pend}
    assert "OLD" in toks and "NEW" not in toks

def test_list_pending_skips_non_pending(tmp_path):
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="A", now=0.0)
    sa.set_status(str(tmp_path), "A", "applied")
    assert sa.list_pending(str(tmp_path), now=100000.0) == []

def test_load_missing_returns_none(tmp_path):
    assert sa.load(str(tmp_path), "NOPE") is None
