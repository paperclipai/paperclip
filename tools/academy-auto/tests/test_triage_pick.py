from academy_auto.config import Config
from academy_auto.triage.scan import Candidate
from academy_auto.triage import pick as pickmod


def _cfg(tmp_path):
    base = Config.default()
    return Config(**{**base.__dict__, "triage_state_path": tmp_path / "triage-state.json"})


def test_triage_and_pick_filters_then_ranks(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path)
    cands = [
        Candidate("tsc", "tsc:a.ts:5:TS1", "a.ts", 5, "err", 50),
        Candidate("todo", "todo:done:1", "b.ts", 1, "x", 10),
    ]
    monkeypatch.setattr(pickmod, "scan_all", lambda cwd, sources=None, github_repo=None: cands)
    # State: der todo:done:1-Kandidat ist erledigt -> muss rausgefiltert werden
    monkeypatch.setattr(pickmod, "load_state", lambda p: {"todo:done:1": {"attempts": 1, "last_status": "committed"}})
    seen = {}
    def fake_rank(fresh, baseline_red=False):
        seen["keys"] = [c.key for c in fresh]
        from academy_auto.triage.rank import Pick
        return Pick("tsc:a.ts:5:TS1", "Fix a.ts", "prio")
    monkeypatch.setattr(pickmod, "rank", fake_rank)
    result = pickmod.triage_and_pick(cfg, "/tmp/wt")
    assert seen["keys"] == ["tsc:a.ts:5:TS1"]  # erledigter Kandidat gefiltert
    assert result.chosen_key == "tsc:a.ts:5:TS1"


def test_triage_and_pick_none_when_no_fresh(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path)
    monkeypatch.setattr(pickmod, "scan_all", lambda cwd, sources=None, github_repo=None: [])
    monkeypatch.setattr(pickmod, "load_state", lambda p: {})
    called = {"rank": False}
    def fake_rank(fresh, baseline_red=False):
        called["rank"] = True
        return None
    monkeypatch.setattr(pickmod, "rank", fake_rank)
    assert pickmod.triage_and_pick(cfg, "/tmp/wt") is None
    assert called["rank"] is False  # ohne Kandidaten kein Ranker-Aufruf


def test_config_default_has_triage_state_path():
    cfg = Config.default()
    assert cfg.triage_state_path.name == "triage-state.json"
