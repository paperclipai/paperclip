"""GSC-REST-Client. Session wird injiziert (Produktion: google.auth AuthorizedSession;
Test: gemockte requests.Session)."""
import datetime
import requests

GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
API_BASE = "https://www.googleapis.com/webmasters/v3"


def report_windows(today):
    end = today - datetime.timedelta(days=3)
    last = (end - datetime.timedelta(days=6), end)
    prev = (end - datetime.timedelta(days=13), end - datetime.timedelta(days=7))
    fmt = lambda d: d.isoformat()
    return (fmt(last[0]), fmt(last[1])), (fmt(prev[0]), fmt(prev[1]))


class GSCClient:
    def __init__(self, session):
        self.http = session

    def list_properties(self):
        r = self.http.get(f"{API_BASE}/sites", timeout=30)
        r.raise_for_status()
        return [e["siteUrl"] for e in r.json().get("siteEntry", [])]

    def _query(self, property_url, body):
        prop = requests.utils.quote(property_url, safe="")
        r = self.http.post(f"{API_BASE}/sites/{prop}/searchAnalytics/query",
                           json=body, timeout=30)
        r.raise_for_status()
        return r.json()

    def fetch_totals(self, property_url, start, end):
        data = self._query(property_url, {"startDate": start, "endDate": end})
        rows = data.get("rows") or []
        if not rows:
            return {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0}
        row = rows[0]
        return {"clicks": int(row.get("clicks", 0)),
                "impressions": int(row.get("impressions", 0)),
                "ctr": float(row.get("ctr", 0.0)),
                "position": float(row.get("position", 0.0))}

    def fetch_top(self, property_url, dimension, start, end, limit):
        data = self._query(property_url, {"startDate": start, "endDate": end,
                                          "dimensions": [dimension], "rowLimit": limit})
        out = []
        for row in data.get("rows") or []:
            out.append({"key": row["keys"][0],
                        "clicks": int(row.get("clicks", 0)),
                        "impressions": int(row.get("impressions", 0)),
                        "ctr": float(row.get("ctr", 0.0)),
                        "position": float(row.get("position", 0.0))})
        return out

    def fetch_query_metrics(self, property_url, queries, start, end):
        if not queries:
            return []
        body = {"startDate": start, "endDate": end, "dimensions": ["query"],
                "dimensionFilterGroups": [{
                    "groupType": "or",
                    "filters": [{"dimension": "query", "operator": "equals", "expression": q}
                                for q in queries]}],
                "rowLimit": max(len(queries), 25)}
        data = self._query(property_url, body)
        out = []
        for row in data.get("rows") or []:
            out.append({"key": row["keys"][0],
                        "clicks": int(row.get("clicks", 0)),
                        "impressions": int(row.get("impressions", 0)),
                        "ctr": float(row.get("ctr", 0.0)),
                        "position": float(row.get("position", 0.0))})
        return out


def build_authorized_session(key_file, scopes=(GSC_SCOPE,)):
    """Produktions-Session mit Service-Account-Auth. Nicht unit-getestet (google-Plumbing)."""
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    creds = service_account.Credentials.from_service_account_file(key_file, scopes=list(scopes))
    return AuthorizedSession(creds)
