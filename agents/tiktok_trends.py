"""
Módulo: Social Trends
Extrae tendencias reales de fuentes públicas sin autenticación.

Fuentes:
  - Google Trends RSS (trending searches por país — MX, ES, CO, AR)
  - TikTok Creative Center hashtags (cuando esté disponible)

Sin API keys — datos 100% públicos.
"""
import json
import urllib.request
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET
import re
from datetime import datetime, timezone


# ── Google Trends RSS ─────────────────────────────────────────────────────────

COUNTRY_CODES = {
    "mx": "MX",
    "es": "ES",
    "co": "CO",
    "ar": "AR",
    "us": "US",
}

# Google Trends RSS — intentar ambos endpoints (el viejo y el nuevo)
GOOGLE_TRENDS_RSS_URLS = [
    "https://trends.google.com/trending/rss?geo={geo}",
    "https://trends.google.com/trends/trendingsearches/daily/rss?geo={geo}",
]

GT_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":          "application/rss+xml, application/xml, text/xml, */*",
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
}


def get_google_trends(country: str = "mx", limit: int = 15) -> list:
    """
    Obtiene trending searches de Google Trends RSS.
    Devuelve lista de {term, traffic, related_queries}.
    """
    geo = COUNTRY_CODES.get(country.lower(), "MX")
    xml_content = None

    for url_template in GOOGLE_TRENDS_RSS_URLS:
        url = url_template.format(geo=geo)
        req = urllib.request.Request(url, headers=GT_HEADERS, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                xml_content = r.read().decode("utf-8", errors="replace")
            break  # éxito — salir del loop
        except Exception as e:
            print(f"  ⚠️  Google Trends error ({country}, {url[:50]}): {e}", flush=True)

    if not xml_content:
        return []

    try:
        root    = ET.fromstring(xml_content)
        channel = root.find("channel")
        if channel is None:
            return []

        results = []
        ns      = {"ht": "https://trends.google.com/trends/trendingsearches"}

        for item in list(channel.findall("item"))[:limit]:
            title   = item.findtext("title", "").strip()
            traffic = item.findtext("ht:approx_traffic", "0", ns).replace("+", "").replace(",", "")

            # Related queries
            related = []
            for rq in item.findall("ht:related_queries/ht:item/ht:query", ns):
                if rq.text:
                    related.append(rq.text.strip())

            # News title (contexto del trend)
            news_title = ""
            news_item  = item.find("ht:news_item/ht:news_item_title", ns)
            if news_item is not None and news_item.text:
                news_title = news_item.text.strip()

            if title:
                results.append({
                    "term":            title,
                    "traffic":         int(traffic) if traffic.isdigit() else 0,
                    "related":         related[:5],
                    "news_context":    news_title,
                })

        return results

    except ET.ParseError as e:
        print(f"  ⚠️  Google Trends XML parse error: {e}", flush=True)
        return []


def trends_to_hashtags(trends: list) -> list:
    """Convierte trending searches en hashtags para TikTok/YouTube."""
    hashtags = []
    for t in trends:
        term = t.get("term", "")
        # Convertir a hashtag: quitar espacios y caracteres especiales
        tag = "#" + re.sub(r'[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ]', '', term.replace(" ", ""))
        if len(tag) > 2:
            hashtags.append(tag)
        # Añadir queries relacionadas también
        for rel in t.get("related", [])[:2]:
            rel_tag = "#" + re.sub(r'[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ]', '', rel.replace(" ", ""))
            if len(rel_tag) > 2:
                hashtags.append(rel_tag)
    return list(dict.fromkeys(hashtags))[:20]  # dedup + limit


def format_number(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.0f}K"
    return str(n)


def build_tiktok_trends_context(countries: list = None) -> str:
    """
    Construye un bloque de contexto con tendencias reales.
    Usa Google Trends RSS (público, sin auth).
    """
    if countries is None:
        countries = ["mx", "es", "co"]

    lines = [
        f"## 📈 TENDENCIAS REALES — Google Trends + Redes Sociales\n",
        f"Fecha: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n",
    ]

    all_terms    = []
    all_hashtags = []

    for country in countries:
        country_names = {"mx": "México", "es": "España", "co": "Colombia",
                         "ar": "Argentina", "us": "EEUU"}
        country_name  = country_names.get(country, country.upper())

        print(f"  📡 Google Trends para {country_name}...", flush=True)
        trends = get_google_trends(country, limit=15)

        if not trends:
            continue

        lines.append(f"### 🔥 Trending en {country_name} ahora")
        for t in trends[:10]:
            traffic_str = format_number(t["traffic"]) if t["traffic"] else "?"
            related_str = " · ".join(t["related"][:3]) if t["related"] else ""
            news_str    = f" _(contexto: {t['news_context'][:60]})_" if t["news_context"] else ""
            lines.append(f"  • **{t['term']}** — {traffic_str} búsquedas{news_str}")
            if related_str:
                lines.append(f"    Relacionado: {related_str}")
            all_terms.append(t["term"])

        # Generar hashtags desde trends
        country_hashtags = trends_to_hashtags(trends[:8])
        all_hashtags.extend(country_hashtags)
        if country_hashtags:
            lines.append(f"\n  💡 Hashtags sugeridos: {' '.join(country_hashtags[:8])}")
        lines.append("")

    # Hashtags multi-país (más relevantes para el nicho LATAM)
    if all_hashtags:
        unique_tags = list(dict.fromkeys(all_hashtags))[:15]
        lines.append("### 🌎 Hashtags LATAM recomendados para el video")
        lines.append("  " + " ".join(unique_tags))
        lines.append("")

    if len(lines) <= 3:
        return ""

    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    print(build_tiktok_trends_context(["mx", "es"]))
