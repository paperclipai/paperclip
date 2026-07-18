import requests

_YOAST_MAP = {
    "seo_title": "_yoast_wpseo_title",
    "meta_description": "_yoast_wpseo_metadesc",
    "og_title": "_yoast_wpseo_opengraph-title",
    "og_description": "_yoast_wpseo_opengraph-description",
    "canonical": "_yoast_wpseo_canonical",
    "focus_keyword": "_yoast_wpseo_focuskw",
}

_ENDPOINT = {"post": "posts", "page": "pages", "media": "media"}


class WPClient:
    def __init__(self, rest_base, auth, session=None):
        self.base = rest_base.rstrip("/")
        self.auth = auth
        self.http = session or requests.Session()

    def check_editable(self, target, obj_id):
        """Prüft VOR dem Schreiben, ob das Objekt existiert und editierbar ist.

        Liefert None wenn ok, sonst eine Fehlerbeschreibung. Fängt u.a. die von
        WordPress geschützte Datenschutzseite ab (403 rest_forbidden_context für
        Redakteure) sowie erfundene IDs (404).
        """
        ep = _ENDPOINT.get(target)
        if ep is None:
            return None  # target "site" hat kein Objekt zu prüfen
        r = self.http.get(f"{self.base}/wp/v2/{ep}/{obj_id}",
                          params={"context": "edit"}, auth=self.auth, timeout=30)
        if r.status_code == 200:
            return None
        try:
            code = r.json().get("code", "")
        except ValueError:
            code = ""
        return f"nicht editierbar (HTTP {r.status_code} {code})".strip()

    def _post(self, path, payload):
        r = self.http.post(f"{self.base}{path}", json=payload, auth=self.auth, timeout=30)
        r.raise_for_status()
        return r.json()

    def get_post_meta(self, post_id):
        r = self.http.get(f"{self.base}/wp/v2/posts/{post_id}", auth=self.auth, timeout=30)
        r.raise_for_status()
        return r.json().get("meta", {})

    def set_yoast_meta(self, post_id, field, value, post_type="posts"):
        key = _YOAST_MAP[field]
        return self._post(f"/wp/v2/{post_type}/{post_id}", {"meta": {key: value}})

    def set_alt_text(self, media_id, value):
        return self._post(f"/wp/v2/media/{media_id}", {"alt_text": value})

    def set_llms_txt(self, value):
        return self._post("/whitestag-seo-geo/v1/llms", {"content": value})

    def set_gsc_verification(self, token):
        return self._post("/whitestag-seo-geo/v1/gsc-verify", {"token": token})

    def find_id_by_slug(self, endpoint, slug):
        """WordPress-Objekt-ID per Slug finden. endpoint = 'posts' oder 'pages'.
        Liefert die ID (int) oder None, wenn nichts passt."""
        r = self.http.get(f"{self.base}/wp/v2/{endpoint}",
                          params={"slug": slug, "_fields": "id"}, auth=self.auth, timeout=30)
        r.raise_for_status()
        rows = r.json()
        return rows[0]["id"] if isinstance(rows, list) and rows else None

    def get_ai_bot_hits(self):
        """Ruft die KI-Bot-Zugriffszahlen vom mu-Plugin ab.

        Returns:
            Dict mit ISO-Wochen-Keys und Bot-Count-Values
        """
        r = self.http.get(f"{self.base}/whitestag-seo-geo/v1/aibots",
                          auth=self.auth, timeout=30)
        r.raise_for_status()
        return r.json()
