"""
Agente: Ad Spy — DiscontrolDrops
Valida demanda de productos usando múltiples fuentes públicas:
- Google Trends RSS (tendencia de búsqueda)
- YouTube Search (reviews y unboxings = demanda orgánica)
- Amazon Search (reseñas, ratings, competencia)
- Google Shopping (anunciantes activos)

Input (JSON del Product Hunter):
{
  "products": [...],
  "niche": "accesorios bebés"
}

Output: validación de demanda por producto con score de evidencia.
"""
import os
import sys
import json
import re
import urllib.request
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BROWSER_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,*/*;q=0.9",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
}


# ── Google Trends ─────────────────────────────────────────────────────────────

def check_google_trends(keyword: str, geo: str = "ES") -> dict:
    """Comprueba si el keyword está en trending searches."""
    try:
        url = f"https://trends.google.com/trending/rss?geo={geo}"
        req = urllib.request.Request(url, headers=BROWSER_HEADERS, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            xml = r.read().decode("utf-8", errors="replace")
        root = ET.fromstring(xml)
        ch   = root.find("channel")
        terms = []
        if ch:
            for item in list(ch.findall("item"))[:20]:
                title = item.findtext("title", "").strip().lower()
                terms.append(title)
        kw_lower = keyword.lower()
        is_trending = any(
            any(w in term for w in kw_lower.split() if len(w) > 3)
            for term in terms
        )
        return {"trending": is_trending, "terms_checked": len(terms)}
    except Exception as e:
        print(f"  ⚠️  Google Trends error: {e}", flush=True)
        return {"trending": False, "terms_checked": 0}


# ── YouTube ───────────────────────────────────────────────────────────────────

def check_youtube(keyword: str) -> dict:
    """Busca reviews y unboxings en YouTube. Resultados = demanda orgánica."""
    try:
        query   = urllib.parse.quote(f"{keyword} review unboxing opinión")
        url     = f"https://www.youtube.com/results?search_query={query}&sp=CAISAhAB"  # sorted by upload date
        req     = urllib.request.Request(url, headers=BROWSER_HEADERS, method="GET")
        with urllib.request.urlopen(req, timeout=12) as r:
            html = r.read().decode("utf-8", errors="replace")

        # Extraer títulos de videos y view counts
        titles      = re.findall(r'"title":\{"runs":\[{"text":"([^"]{5,80})"', html)[:10]
        view_counts = re.findall(r'"viewCountText":\{"simpleText":"([^"]+)"', html)[:10]

        # Filtrar relevantes al producto
        kw_words  = [w.lower() for w in keyword.split() if len(w) > 3]
        relevant  = [t for t in titles if any(w in t.lower() for w in kw_words)]

        return {
            "total_results":   len(titles),
            "relevant_videos": len(relevant),
            "sample_titles":   relevant[:3],
            "has_demand":      len(relevant) >= 2,
        }
    except Exception as e:
        print(f"  ⚠️  YouTube error: {e}", flush=True)
        return {"total_results": 0, "relevant_videos": 0, "sample_titles": [], "has_demand": False}


# ── Amazon ────────────────────────────────────────────────────────────────────

def check_amazon(keyword: str) -> dict:
    """Busca el producto en Amazon ES. Fallback a Amazon.com si ES falla."""
    urls = [
        f"https://www.amazon.es/s?k={urllib.parse.quote(keyword)}",
        f"https://www.amazon.com/s?k={urllib.parse.quote(keyword)}",
    ]
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={
                **BROWSER_HEADERS,
                "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
                "Cache-Control": "no-cache",
            }, method="GET")
            with urllib.request.urlopen(req, timeout=15) as r:
                html = r.read().decode("utf-8", errors="replace")

            # Contar resultados
            result_count = 0
            results_m = re.search(r'(\d[\d\.,]+)\s+results?\s+for|(\d[\d\.,]+)\s+resultado', html, re.IGNORECASE)
            if results_m:
                num_str = (results_m.group(1) or results_m.group(2) or "0").replace(",", "").replace(".", "")
                try: result_count = int(num_str[:8])
                except Exception: pass

            # Si no hay count pero hay productos listados, estimar
            if result_count == 0:
                product_hits = len(re.findall(r'data-asin="[A-Z0-9]{10}"', html))
                result_count = product_hits * 10 if product_hits > 0 else 0

            # Ratings
            ratings = re.findall(r'(\d\.\d)\s+out of 5|(\d\.\d)\s+de 5', html)[:5]
            vals = [float(r[0] or r[1]) for r in ratings if (r[0] or r[1])]
            avg_rating = round(sum(vals) / len(vals), 1) if vals else 0.0

            competition = "High" if result_count > 5000 else "Med" if result_count > 500 else "Low"
            return {
                "result_count": result_count,
                "avg_rating":   avg_rating,
                "competition":  competition,
                "has_market":   result_count > 30 or len(vals) > 0,
                "available":    True,
            }
        except Exception as e:
            print(f"  ⚠️  Amazon error ({url[:30]}): {e}", flush=True)
            continue

    return {"result_count": 0, "avg_rating": 0, "competition": "Unknown", "has_market": False, "available": False}


# ── Google Shopping ───────────────────────────────────────────────────────────

def check_google_shopping(keyword: str) -> dict:
    """Verifica si hay anunciantes en Google Shopping (= producto rentable)."""
    try:
        query = urllib.parse.quote(keyword)
        url   = f"https://www.google.es/search?q={query}&tbm=shop&hl=es"
        req   = urllib.request.Request(url, headers=BROWSER_HEADERS, method="GET")
        with urllib.request.urlopen(req, timeout=12) as r:
            html = r.read().decode("utf-8", errors="replace")

        # Buscar resultados de shopping
        shop_results  = len(re.findall(r'class="[^"]*sh-dgr__grid-result[^"]*"', html))
        has_ads       = 'aria-label="Anuncio"' in html or 'aria-label="Ad"' in html or "Patrocinado" in html
        merchant_count = len(set(re.findall(r'"merchant":"([^"]{2,50})"', html)))

        return {
            "shopping_results": shop_results,
            "has_paid_ads":     has_ads,
            "merchants":        merchant_count,
            "validated":        shop_results > 3 or has_ads,
        }
    except Exception as e:
        print(f"  ⚠️  Google Shopping error: {e}", flush=True)
        return {"shopping_results": 0, "has_paid_ads": False, "merchants": 0, "validated": False}


# ── Puntuación de evidencia ───────────────────────────────────────────────────

def calculate_evidence_score(trends: dict, youtube: dict, shopping: dict) -> int:
    """Score 0-100 basado en 3 fuentes fiables (Amazon bloqueado sistemáticamente)."""
    score = 0

    # YouTube — señal más fuerte (demanda orgánica real)
    yt_videos = youtube.get("relevant_videos", 0)
    if youtube.get("has_demand"):   score += 35
    if yt_videos >= 5:              score += 15
    elif yt_videos >= 3:            score += 8

    # Google Trends — tendencia de búsqueda
    if trends.get("trending"):      score += 25

    # Google Shopping — anunciantes activos = producto rentable
    if shopping.get("validated"):   score += 20
    if shopping.get("has_paid_ads"): score += 5

    return min(score, 100)


# ── Input/Output ──────────────────────────────────────────────────────────────

def extract_input(raw: str) -> tuple:
    json_str = None
    if "```json" in raw:
        json_str = raw.split("```json")[1].split("```")[0].strip()
    elif raw.strip().startswith("{"):
        json_str = raw.strip()
    else:
        m = re.search(r'\{[\s\S]*?"products"[\s\S]*?\}', raw)
        if m: json_str = m.group(0)
    if json_str:
        try:
            data = json.loads(json_str)
            return data.get("products", []), data.get("niche", "products")
        except Exception:
            pass
    return [{"name": raw.strip()[:100]}], raw.strip()


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    if not raw:
        raw = "accesorios bebé"

    products, niche = extract_input(raw)
    products = products[:6]  # máximo 6 para no tardar demasiado

    post_issue_comment(
        f"🕵️ Ad Spy validando demanda de **{len(products)} productos**...\n\n"
        f"Fuentes: Google Trends · YouTube · Google Shopping"
    )
    print(f"🕵️ {len(products)} productos | nicho: {niche}", flush=True)

    results = []
    for i, product in enumerate(products):
        name = product.get("name", product.get("term", f"Product {i+1}"))
        print(f"\n  [{i+1}/{len(products)}] {name[:50]}...", flush=True)

        trends   = check_google_trends(name)
        youtube  = check_youtube(name)
        shopping = check_google_shopping(name)
        score    = calculate_evidence_score(trends, youtube, shopping)

        result = {
            "product":        name,
            "evidence_score": score,
            "validated":      score >= 40,
            "sources": {
                "google_trends":   trends,
                "youtube":         youtube,
                "google_shopping": shopping,
            },
        }
        results.append(result)
        print(f"    Evidence score: {score}/100 | validated: {result['validated']}", flush=True)

    results.sort(key=lambda r: r["evidence_score"], reverse=True)

    lines = [f"# 🕵️ AD SPY — Validación Multi-Fuente\n"]
    lines.append(f"**{len(results)} productos analizados** · Fuentes: Google Trends + YouTube + Google Shopping\n")

    for r in results:
        score = r["evidence_score"]
        emoji = "🟢" if score >= 60 else "🟡" if score >= 40 else "🔴"
        badge = "✅ VALIDADO" if r["validated"] else "⚠️ DÉBIL"
        s     = r["sources"]

        lines.append(f"---\n## {emoji} {r['product']}")
        lines.append(f"**Evidence Score: {score}/100** · {badge}\n")
        lines.append(f"| Fuente | Resultado |")
        lines.append(f"|---|---|")
        lines.append(f"| 📈 Google Trends | {'🔥 Trending' if s['google_trends']['trending'] else '➡️ Estable'} |")
        lines.append(f"| 📺 YouTube | {s['youtube']['relevant_videos']} videos relevantes {'✅' if s['youtube']['has_demand'] else '⚠️'} |")
        lines.append(f"| 🛍️ Google Shopping | {'✅ Anunciantes activos' if s['google_shopping']['validated'] else '⚠️ Sin anunciantes'} |")

        if s['youtube']['sample_titles']:
            lines.append(f"\n**Videos encontrados:**")
            for t in s['youtube']['sample_titles'][:2]:
                lines.append(f"- {t}")
        lines.append("")

    output_json = {"results": results, "niche": niche, "total": len(results)}
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    output = "\n".join(lines)
    print(output[:300], flush=True)
    post_issue_result(output)


if __name__ == "__main__":
    main()
