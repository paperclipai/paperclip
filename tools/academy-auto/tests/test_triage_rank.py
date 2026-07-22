from academy_auto.triage.scan import Candidate
from academy_auto.triage.rank import rank, Pick


def _cands():
    return [
        Candidate("tsc", "tsc:a.ts:5:TS1", "a.ts", 5, "Object possibly null", 50),
        Candidate("todo", "todo:b.ts:1", "b.ts", 1, "TODO validate", 10),
    ]


def test_rank_returns_valid_pick():
    def ranker(prompt):
        assert "tsc:a.ts:5:TS1" in prompt  # Kandidaten stehen im Prompt
        return '{"chosen_key": "tsc:a.ts:5:TS1", "task_prompt": "Fix null bug in a.ts:5", "reason": "höchste Priorität"}'
    pick = rank(_cands(), ranker=ranker)
    assert isinstance(pick, Pick)
    assert pick.chosen_key == "tsc:a.ts:5:TS1"
    assert "a.ts" in pick.task_prompt
    assert pick.reason == "höchste Priorität"


def test_rank_rejects_key_not_in_candidates():
    pick = rank(_cands(), ranker=lambda p: '{"chosen_key": "erfunden:1", "task_prompt": "x", "reason": "y"}')
    assert pick is None


def test_rank_none_on_empty_task_prompt():
    pick = rank(_cands(), ranker=lambda p: '{"chosen_key": "todo:b.ts:1", "task_prompt": "", "reason": "y"}')
    assert pick is None


def test_rank_none_on_non_json():
    assert rank(_cands(), ranker=lambda p: "kein json hier") is None


def test_rank_none_on_empty_candidates():
    assert rank([], ranker=lambda p: '{"chosen_key":"x","task_prompt":"y","reason":"z"}') is None


def test_rank_fail_soft_when_ranker_raises():
    def boom(prompt):
        raise RuntimeError("claude weg")
    assert rank(_cands(), ranker=boom) is None


def test_rank_extracts_json_embedded_in_prose():
    raw = 'Klar! Hier meine Wahl:\n{"chosen_key": "todo:b.ts:1", "task_prompt": "TODO b umsetzen", "reason": "einfach"}\nViel Erfolg.'
    pick = rank(_cands(), ranker=lambda p: raw)
    assert pick is not None and pick.chosen_key == "todo:b.ts:1"


def test_default_ranker_calls_claude(monkeypatch):
    from academy_auto.triage import rank as rankmod
    captured = {}
    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        class R:
            stdout = '{"ok": true}'
            stderr = ""
            returncode = 0
        return R()
    monkeypatch.setattr(rankmod.subprocess, "run", fake_run)
    out = rankmod._default_ranker("mein prompt")
    assert out == '{"ok": true}'
    assert captured["cmd"][:len(rankmod.RANK_CMD)] == rankmod.RANK_CMD
    assert "mein prompt" in captured["cmd"]
