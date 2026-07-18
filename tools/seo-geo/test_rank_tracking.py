from rank_tracking import pos_delta, build_site_ranks, render_markdown


def _row(key, pos, imp=10):
    return {"key": key, "position": pos, "impressions": imp, "clicks": 0, "ctr": 0.0}


def test_pos_delta_positiv_ist_verbesserung():
    assert pos_delta(8.0, 5.0) == 3.0     # von Pos 8 auf 5 = +3 (besser)
    assert pos_delta(5.0, 8.0) == -3.0
    assert pos_delta(None, 5.0) is None


def test_build_site_ranks_union_core_und_auto():
    cur = [_row("a", 5.0), _row("b", 12.0)]
    prev = [_row("a", 8.0)]
    ranks = build_site_ranks(cur, prev, core_keys={"a", "z"})
    by = {r["key"]: r for r in ranks}
    assert by["a"]["core"] is True and by["a"]["delta"] == 3.0 and by["a"]["position"] == 5.0
    assert by["b"]["core"] is False and by["b"]["delta"] is None      # keine Vorwoche für b
    assert by["z"]["core"] is True and by["z"].get("missing") is True # core ohne Impressionen


def test_render_markdown_zeigt_pfeile_und_keys():
    md = render_markdown([{"name": "whitestag.film", "ranks": [
        {"key": "a", "core": True, "position": 5.0, "impressions": 40, "delta": 3.0},
        {"key": "z", "core": True, "missing": True}]}])
    assert "whitestag.film" in md and "a" in md and "z" in md
    assert "↑" in md   # Verbesserung
