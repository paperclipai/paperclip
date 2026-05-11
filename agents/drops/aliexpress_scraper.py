"""
Agente: AliExpress Scraper — DiscontrolDrops
Busca productos en AliExpress ES y extrae datos reales:
- Título, precio EUR, unidades vendidas, imágenes, URL producto

No requiere API key — scraping HTTP directo del HTML embebido.
AliExpress incluye JSON de productos en el HTML de búsqueda.

Input (desde issue o Product Hunter):
  "dog led collar"
  {"query": "collar led perro", "limit": 10}

Output: lista de productos con datos reales de AliExpress.
"""
import os
import sys
import json
import re
import urllib.request
import urllib.parse
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BASE_URL = "https://es.aliexpress.com/w/wholesale-{slug}.html"

HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://es.aliexpress.com/",
    "Cache-Control":   "no-cache",
}


def query_to_slug(query: str) -> str:
    """Convierte query a slug de URL de AliExpress."""
    return urllib.parse.quote(query.strip().replace(" ", "-"))


def fetch_html(query: str) -> str:
    """Fetches search results HTML from AliExpress ES."""
    slug = query_to_slug(query)
    url  = BASE_URL.format(slug=slug)
    print(f"  📡 GET {url}", flush=True)
    req = urllib.request.Request(url, headers=HEADERS, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            # Handle gzip
            raw = r.read()
            try:
                import gzip
                raw = gzip.decompress(raw)
            except Exception:
                pass
            return raw.decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  ⚠️  Fetch error: {e}", flush=True)
        return ""


def extract_products(html: str, limit: int = 10) -> list:
    """
    Extrae productos del JSON embebido en el HTML de AliExpress.
    AliExpress incluye datos de productos en múltiples estructuras JSON.
    """
    products = []

    # Extraer precios formateados
    prices = re.findall(r'"formattedPrice":"(€\s*[\d,\.]+)"', html)
    # Extraer unidades vendidas
    trade_descs = re.findall(r'"tradeDesc":"([^"]+)"', html)
    # Extraer IDs de producto
    product_ids = re.findall(r'"productId":"(\d{10,})"', html)
    # Extraer imágenes (CDN aliexpress)
    images = re.findall(
        r'"((?:https:)?//ae\d*\.alicdn\.com/kf/[A-Za-z0-9_/]+\.[a-z]{3,4})"',
        html
    )
    # Extraer títulos (en el bloque de datos del producto)
    titles = re.findall(
        r'"title":"([^"]{15,120})"',
        html
    )
    # Filtrar títulos que sean nombres de producto (no UI)
    ui_strings = {"ofertas", "descuentos", "entrega", "servicio", "calidad",
                  "confianza", "envío", "compra", "gratis", "pago", "seguro"}
    titles = [t for t in titles if not any(s in t.lower() for s in ui_strings)]

    # Deduplicar product_ids manteniendo orden
    seen_ids = set()
    unique_ids = []
    for pid in product_ids:
        if pid not in seen_ids:
            seen_ids.add(pid)
            unique_ids.append(pid)

    # Limpiar imágenes — tomar solo las que parecen fotos de producto
    product_images = []
    for img in images:
        if img.startswith("//"):
            img = "https:" + img
        if any(ext in img for ext in [".jpg", ".jpeg", ".png", ".webp"]):
            if img not in product_images:
                product_images.append(img)
        if len(product_images) >= limit * 3:
            break

    print(f"  📦 IDs: {len(unique_ids)} | Precios: {len(prices)} | "
          f"Títulos: {len(titles)} | Imágenes: {len(product_images)}", flush=True)

    # Combinar datos por índice
    for i, pid in enumerate(unique_ids[:limit]):
        title = titles[i] if i < len(titles) else f"Producto AliExpress #{pid}"
        price = prices[i * 2] if i * 2 < len(prices) else (prices[i] if i < len(prices) else "?")
        trade = trade_descs[i] if i < len(trade_descs) else ""
        img   = product_images[i] if i < len(product_images) else ""

        # Limpiar precio
        price_clean = price.replace("€", "").replace("\xa0", "").strip()
        try:
            price_eur = float(price_clean.replace(",", "."))
        except Exception:
            price_eur = 0.0

        products.append({
            "product_id":    pid,
            "title":         title,
            "price_eur":     price_eur,
            "price_fmt":     price,
            "orders":        trade,
            "image_url":     img,
            "aliexpress_url": f"https://es.aliexpress.com/item/{pid}.html",
            "source":        "aliexpress",
        })

    return products


def parse_input(raw: str) -> dict:
    """Extrae query y limit del input."""
    m = re.search(r'\{[\s\S]*?\}', raw)
    if m:
        try:
            data = json.loads(m.group(0))
            return {
                "query": data.get("query", data.get("niche", raw.strip())),
                "limit": int(data.get("limit", 10)),
            }
        except Exception:
            pass
    return {"query": raw.strip() or "trending products", "limit": 10}


def main():
    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    if not raw:
        raw = "dog led collar"

    params = parse_input(raw)
    query  = params["query"]
    limit  = params["limit"]

    post_issue_comment(f"🛒 AliExpress Scraper buscando: **{query}**")
    print(f"🛒 Query: '{query}' | Limit: {limit}", flush=True)

    html = fetch_html(query)
    if not html:
        post_issue_result(f"❌ AliExpress Scraper: no se pudo obtener HTML para '{query}'")
        sys.exit(1)

    products = extract_products(html, limit=limit)
    print(f"✅ {len(products)} productos extraídos", flush=True)

    if not products:
        post_issue_result(f"⚠️ AliExpress Scraper: sin resultados para '{query}'. "
                          f"Prueba con términos en inglés (ej: 'dog led collar').")
        return

    # Formatear output
    lines = [f"# 🛒 ALIEXPRESS SCRAPER — {query}\n"]
    lines.append(f"**{len(products)} productos encontrados** en es.aliexpress.com\n")

    for i, p in enumerate(products, 1):
        orders_badge = f"📦 {p['orders']}" if p['orders'] else ""
        lines.append(f"## {i}. {p['title'][:80]}")
        lines.append(f"- 💶 Precio: **{p['price_fmt']}** {orders_badge}")
        lines.append(f"- 🔗 [{p['aliexpress_url']}]({p['aliexpress_url']})")
        if p['image_url']:
            lines.append(f"- 🖼️ `{p['image_url'][:80]}`")
        lines.append("")

    output_json = {
        "products": products,
        "query":    query,
        "total":    len(products),
        "source":   "aliexpress_es",
    }
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    output = "\n".join(lines)
    print(output[:500], flush=True)
    post_issue_result(output)


if __name__ == "__main__":
    main()
