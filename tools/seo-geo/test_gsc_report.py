from config import Site
from gsc_report import (delta_pct, ampel, movers, resolve_property,
                        build_site_block, overall_ampel, render_markdown)

def _site(name="whitestag.film", url="https://www.whitestag.film", prop=None):
    return Site(name=name, url=url, wp_rest_base=url + "/wp-json",
                credential_ref="X", crawl_limit=10, seo_plugin="yoast", gsc_property=prop)

def test_delta_pct_normal():
    assert delta_pct(120, 100) == 20.0
    assert delta_pct(80, 100) == -20.0

def test_delta_pct_prev_null_ist_none():
    assert delta_pct(50, 0) is None

def test_ampel_schwellen():
    assert ampel(None) == "🟢"
    assert ampel(-5) == "🟢"
    assert ampel(-10) == "🟢"
    assert ampel(-10.1) == "🟡"
    assert ampel(-25) == "🟡"
    assert ampel(-25.1) == "🔴"

def test_movers_gewinner_und_verlierer():
    prev = [{"key": "a", "clicks": 100}, {"key": "b", "clicks": 50}, {"key": "c", "clicks": 10}]
    cur = [{"key": "a", "clicks": 60}, {"key": "b", "clicks": 90}, {"key": "c", "clicks": 12}]
    win, lose = movers(prev, cur, n=1)
    assert win[0]["key"] == "b" and win[0]["delta"] == 40
    assert lose[0]["key"] == "a" and lose[0]["delta"] == -40

class _FakeClient:
    def __init__(self, props=None, totals=None, top=None):
        self._props = props or []
        self._totals = totals or {}
        self._top = top or {}
    def list_properties(self):
        return self._props
    def fetch_totals(self, prop, start, end):
        return self._totals.get((start, end), {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0})
    def fetch_top(self, prop, dim, start, end, limit):
        # Key auf (dim, start, limit), damit Top-5 (Anzeige) und Top-25 (Movers-
        # Vergleich) im selben Zeitraum unterschiedliche Fixtures liefern können.
        return self._top.get((dim, start, limit), self._top.get((dim, start), []))


class _FlakyClient(_FakeClient):
    """Wirft beim allerersten Aufruf, danach normales _FakeClient-Verhalten."""
    def __init__(self, *args, fail_forever=False, **kwargs):
        super().__init__(*args, **kwargs)
        self._failed_once = False
        self._fail_forever = fail_forever

    def fetch_totals(self, prop, start, end):
        if self._fail_forever or not self._failed_once:
            self._failed_once = True
            raise RuntimeError("timeout")
        return super().fetch_totals(prop, start, end)

def test_resolve_property_explizit():
    assert resolve_property(_site(prop="sc-domain:whitestag.film"), _FakeClient()) == "sc-domain:whitestag.film"

def test_resolve_property_automatch_per_host():
    c = _FakeClient(props=["sc-domain:whitestag.film", "https://other.de/"])
    assert resolve_property(_site(), c) == "sc-domain:whitestag.film"

def test_resolve_property_kein_treffer_none():
    assert resolve_property(_site(), _FakeClient(props=["https://other.de/"])) is None

def test_build_site_block_ohne_property():
    b = build_site_block(_site(), _FakeClient(props=[]), (("2026-07-09", "2026-07-15"), ("2026-07-02", "2026-07-08")))
    assert b["ok"] is False and "nicht in GSC" in b["error"]

def test_build_site_block_mit_daten_und_ampel():
    w = (("2026-07-09", "2026-07-15"), ("2026-07-02", "2026-07-08"))
    c = _FakeClient(props=["sc-domain:whitestag.film"],
                    totals={("2026-07-09", "2026-07-15"): {"clicks": 60, "impressions": 1000, "ctr": 0.06, "position": 5.0},
                            ("2026-07-02", "2026-07-08"): {"clicks": 100, "impressions": 1200, "ctr": 0.083, "position": 4.5}},
                    top={("query", "2026-07-09"): [{"key": "vr", "clicks": 30, "impressions": 400, "ctr": 0.075, "position": 3.0}]})
    b = build_site_block(_site(prop="sc-domain:whitestag.film"), c, w)
    assert b["ok"] is True
    assert b["deltas"]["clicks"] == -40.0        # (60-100)/100*100
    assert b["ampel"] == "🔴"                     # -40% < -25%
    assert b["top_queries"][0]["key"] == "vr"

def test_overall_ampel_nimmt_schlechteste():
    assert overall_ampel([{"ampel": "🟢"}, {"ampel": "🔴"}, {"ampel": "🟡"}]) == "🔴"

def test_render_markdown_enthaelt_sitename_und_ampel():
    md = render_markdown([{"name": "whitestag.film", "ok": True, "ampel": "🟢",
                           "cur": {"clicks": 60, "impressions": 1000, "ctr": 0.06, "position": 5.0},
                           "deltas": {"clicks": 20.0, "impressions": 5.0, "ctr": 1.0, "position": -0.3},
                           "top_queries": [{"key": "vr", "clicks": 30}], "top_pages": [],
                           "winners": [], "losers": []}])
    assert "whitestag.film" in md and "🟢" in md and "vr" in md


def test_render_markdown_kopf_wird_rot_bei_einer_roten_site():
    md = render_markdown([
        {"name": "whitestag.film", "ok": True, "ampel": "🟢",
         "cur": {"clicks": 60, "impressions": 1000, "ctr": 0.06, "position": 5.0},
         "deltas": {"clicks": 5.0, "impressions": 5.0, "ctr": 1.0, "position": -0.3},
         "top_queries": [], "top_pages": [], "winners": [], "losers": []},
        {"name": "whitestag.ai", "ok": True, "ampel": "🔴",
         "cur": {"clicks": 10, "impressions": 500, "ctr": 0.02, "position": 8.0},
         "deltas": {"clicks": -40.0, "impressions": -10.0, "ctr": -1.0, "position": 1.0},
         "top_queries": [], "top_pages": [], "winners": [], "losers": []},
    ])
    heading = md.splitlines()[1]
    assert heading.startswith("## 🔴")
    assert "Google Search Console" in heading


def test_movers_nutzt_breites_current_set_statt_top5():
    # Query "x" fällt aus den aktuellen Top-5 (tq) raus, ist aber in den
    # aktuellen Top-25 (cq) noch mit fast unveränderten Klicks vertreten.
    # Vorher (Bug): movers(pq, tq) sieht "x" als komplett verschwunden (-50).
    # Nachher: movers(pq, cq) sieht den echten, kleinen Rückgang (-5).
    w = (("2026-07-09", "2026-07-15"), ("2026-07-02", "2026-07-08"))
    totals = {("2026-07-09", "2026-07-15"): {"clicks": 200, "impressions": 2000, "ctr": 0.1, "position": 4.0},
              ("2026-07-02", "2026-07-08"): {"clicks": 200, "impressions": 2000, "ctr": 0.1, "position": 4.0}}
    top = {
        ("query", "2026-07-02", 25): [{"key": "x", "clicks": 50}, {"key": "a", "clicks": 10}],
        ("query", "2026-07-09", 25): [{"key": "x", "clicks": 45}, {"key": "a", "clicks": 90}],
        ("query", "2026-07-09", 5): [{"key": "a", "clicks": 90}],
        ("page", "2026-07-09", 5): [],
    }
    c = _FakeClient(props=["sc-domain:whitestag.film"], totals=totals, top=top)
    b = build_site_block(_site(prop="sc-domain:whitestag.film"), c, w)
    assert b["ok"] is True
    loser_x = next((l for l in b["losers"] if l["key"] == "x"), None)
    assert loser_x is not None
    assert loser_x["delta"] == -5          # nicht -50 (voller Verlust, wie bei tq statt cq)
    assert b["top_queries"] == [{"key": "a", "clicks": 90}]   # Anzeige bleibt Top-5


def test_build_site_block_retry_einmal_dann_ok():
    w = (("2026-07-09", "2026-07-15"), ("2026-07-02", "2026-07-08"))
    totals = {("2026-07-09", "2026-07-15"): {"clicks": 60, "impressions": 1000, "ctr": 0.06, "position": 5.0},
              ("2026-07-02", "2026-07-08"): {"clicks": 100, "impressions": 1200, "ctr": 0.083, "position": 4.5}}
    c = _FlakyClient(props=["sc-domain:whitestag.film"], totals=totals, fail_forever=False)
    b = build_site_block(_site(prop="sc-domain:whitestag.film"), c, w)
    assert b["ok"] is True
    assert b["error"] is None


def test_build_site_block_retry_scheitert_zweimal_dann_block():
    w = (("2026-07-09", "2026-07-15"), ("2026-07-02", "2026-07-08"))
    c = _FlakyClient(props=["sc-domain:whitestag.film"], fail_forever=True)
    b = build_site_block(_site(prop="sc-domain:whitestag.film"), c, w)
    assert b["ok"] is False
    assert "fehlgeschlagen" in b["error"]
