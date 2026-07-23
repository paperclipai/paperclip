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


def test_rank_none_on_whitespace_task_prompt():
    from academy_auto.triage.scan import Candidate
    cands = [Candidate("todo", "todo:b.ts:1", "b.ts", 1, "x", 10)]
    assert rank(cands, ranker=lambda p: '{"chosen_key":"todo:b.ts:1","task_prompt":"   ","reason":"y"}') is None


def test_default_ranker_passes_timeout(monkeypatch):
    from academy_auto.triage import rank as rankmod
    captured = {}
    def fake_run(cmd, **kwargs):
        captured.update(kwargs)
        class R:
            stdout = "{}"; stderr = ""; returncode = 0
        return R()
    monkeypatch.setattr(rankmod.subprocess, "run", fake_run)
    rankmod._default_ranker("p")
    assert captured.get("timeout") == rankmod.RANK_TIMEOUT


def test_select_candidates_never_drops_issues():
    """Der reale Fall: 657 tsc-Fehler duerfen ein Issue nicht verdraengen."""
    from academy_auto.triage.rank import _select_candidates, MAX_CANDIDATES
    many = [Candidate("tsc", f"tsc:f{i}.ts:1:TS1", f"f{i}.ts", 1, "err", 50) for i in range(657)]
    issue = Candidate("issue", "issue:42", "", 0, "Onboarding-Screen bauen", 20)
    sel = _select_candidates(many + [issue])
    assert len(sel) <= MAX_CANDIDATES
    assert any(c.key == "issue:42" for c in sel)


def test_select_candidates_gives_each_source_a_quota():
    from academy_auto.triage.rank import _select_candidates, SOURCE_QUOTA
    many = [Candidate("tsc", f"tsc:f{i}.ts:1:TS1", f"f{i}.ts", 1, "e", 50) for i in range(100)]
    todos = [Candidate("todo", f"todo:t{i}.ts:1", f"t{i}.ts", 1, "TODO", 10) for i in range(10)]
    sel = _select_candidates(many + todos)
    n_todo = sum(1 for c in sel if c.source == "todo")
    assert n_todo >= SOURCE_QUOTA      # niedrigste Prioritaet, aber nicht verdraengt


def test_select_candidates_respects_limit_and_is_deterministic():
    from academy_auto.triage.rank import _select_candidates
    many = [Candidate("tsc", f"tsc:f{i}.ts:1:TS1", f"f{i}.ts", 1, "e", 50) for i in range(50)]
    a = _select_candidates(many, limit=10)
    b = _select_candidates(many, limit=10)
    assert len(a) == 10
    assert [c.key for c in a] == [c.key for c in b]          # deterministisch
    assert [c.key for c in a] == sorted([c.key for c in a])  # nach key sortiert bei gleicher Prio


def test_select_candidates_empty():
    from academy_auto.triage.rank import _select_candidates
    assert _select_candidates([]) == []


def test_build_prompt_contains_issue_despite_many_tsc():
    """End-to-End der Auswahl: das Issue steht wirklich im Ranker-Prompt."""
    from academy_auto.triage.rank import _build_prompt
    many = [Candidate("tsc", f"tsc:f{i}.ts:1:TS1", f"f{i}.ts", 1, "err", 50) for i in range(657)]
    issue = Candidate("issue", "issue:42", "", 0, "Onboarding-Screen bauen", 20)
    prompt = _build_prompt(many + [issue], baseline_red=True)
    assert "issue:42" in prompt
    assert "Onboarding-Screen" in prompt
