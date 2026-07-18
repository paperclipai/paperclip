import datetime, requests, requests_mock
from gsc import GSCClient, report_windows, API_BASE

def _client():
    return GSCClient(requests.Session())

def test_report_windows_lag_und_laenge():
    (ls, le), (ps, pe) = report_windows(datetime.date(2026, 7, 18))
    assert le == "2026-07-15"           # today - 3
    assert ls == "2026-07-09"           # end - 6
    assert pe == "2026-07-08"           # end - 7
    assert ps == "2026-07-02"           # end - 13

def test_list_properties():
    with requests_mock.Mocker() as m:
        m.get(f"{API_BASE}/sites", json={"siteEntry": [
            {"siteUrl": "https://www.whitestag.film/", "permissionLevel": "siteOwner"},
            {"siteUrl": "sc-domain:whitestag.de", "permissionLevel": "siteRestrictedUser"}]})
        assert _client().list_properties() == [
            "https://www.whitestag.film/", "sc-domain:whitestag.de"]

def test_fetch_totals_aggregiert_eine_zeile():
    prop = "https://www.whitestag.film/"
    with requests_mock.Mocker() as m:
        m.post(f"{API_BASE}/sites/{requests.utils.quote(prop, safe='')}/searchAnalytics/query",
               json={"rows": [{"clicks": 120, "impressions": 3400, "ctr": 0.035, "position": 12.4}]})
        t = _client().fetch_totals(prop, "2026-07-09", "2026-07-15")
        assert t == {"clicks": 120, "impressions": 3400, "ctr": 0.035, "position": 12.4}

def test_fetch_totals_ohne_daten_gibt_nullen():
    prop = "sc-domain:whitestag.de"
    with requests_mock.Mocker() as m:
        m.post(f"{API_BASE}/sites/{requests.utils.quote(prop, safe='')}/searchAnalytics/query", json={})
        t = _client().fetch_totals(prop, "2026-07-09", "2026-07-15")
        assert t == {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0}

def test_fetch_top_liefert_keys():
    prop = "https://www.whitestag.film/"
    with requests_mock.Mocker() as m:
        m.post(f"{API_BASE}/sites/{requests.utils.quote(prop, safe='')}/searchAnalytics/query",
               json={"rows": [{"keys": ["vr film"], "clicks": 50, "impressions": 900, "ctr": 0.055, "position": 4.1}]})
        rows = _client().fetch_top(prop, "query", "2026-07-09", "2026-07-15", 5)
        assert rows[0] == {"key": "vr film", "clicks": 50, "impressions": 900, "ctr": 0.055, "position": 4.1}
        assert m.last_request.json()["dimensions"] == ["query"]
        assert m.last_request.json()["rowLimit"] == 5
