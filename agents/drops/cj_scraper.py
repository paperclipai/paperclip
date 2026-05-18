"""
Agente: CJ Dropshipping Scraper — DiscontrolDrops
Busca productos reales en CJ Dropshipping y extrae:
- Título, precio real, imágenes, SKU, inventario, categoría

API oficial CJ Dropshipping — no bloquea desde Railway.
Docs: https://developers.cjdropshipping.com

Variables de entorno:
  CJ_API_KEY  → API key de CJ Dropshipping (cjdropshipping.com/myCJ → API Key)

Input (desde issue, CEO, o Product Hunter):
  "dog led collar"
  {"query": "collar led perro", "limit": 10}

Output: lista de productos reales con precios y fotos del proveedor.
"""
import os
import sys
import json
import re
import time
import urllib.request
import urllib.parse
import urllib.error
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

CJ_BASE    = "https://developers.cjdropshipping.com/api2.0/v1"
TOKEN_FILE = "/tmp/cj_token_cache.json"   # cache del token en Railway


# ── Auth ──────────────────────────────────────────────────────────────────────

def get_access_token(api_key: str) -> str:
    """
    Obtiene o renueva el access token de CJ.
    Cachea en /tmp para no llamar en cada run (límite: 1 call/s).
    Token válido 180 días.
    """
    # Intentar leer cache
    try:
        with open(TOKEN_FILE, "r") as f:
            cache = json.load(f)
        if cache.get("token") and cache.get("expires", 0) > time.time() + 3600:
            print(f"  ✅ CJ token desde cache (expira en "
                  f"{int((cache['expires'] - time.time()) / 86400)} días)", flush=True)
            return cache["token"]
    except Exception:
        pass

    # Obtener token nuevo
    url     = f"{CJ_BASE}/authentication/getAccessToken"
    payload = json.dumps({"apiKey": api_key}).encode("utf-8")
    req     = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        raise Exception(f"CJ auth error: {e}")

    if not data.get("result"):
        raise Exception(f"CJ auth failed: {data.get('message', str(data))}")

    token   = data["data"]["accessToken"]
    expires = time.time() + (180 * 86400)   # 180 días

    try:
        with open(TOKEN_FILE, "w") as f:
            json.dump({"token": token, "expires": expires}, f)
    except Exception:
        pass

    print(f"  ✅ CJ token obtenido (válido 180 días)", flush=True)
    return token


# ── Product search ────────────────────────────────────────────────────────────

def search_products(keyword: str, token: str, limit: int = 10) -> list:
    """
    Busca productos en CJ por keyword usando listV2 (elasticsearch).
    Devuelve lista de productos con datos reales del proveedor.
    """
    params = urllib.parse.urlencode({
        "keyWord":  keyword,
        "pageNum":  1,
        "pageSize": min(limit, 20),
    })
    url = f"{CJ_BASE}/product/list?{params}"
    req = urllib.request.Request(
        url,
        headers={"CJ-Access-Token": token, "Accept": "application/json"},
        method="GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise Exception(f"CJ API HTTP {e.code}: {body[:300]}")

    if not data.get("result"):
        raise Exception(f"CJ search failed: {data.get('message', str(data))}")

    raw_products = data.get("data", {}).get("list", [])
    print(f"  📦 CJ devolvió {len(raw_products)} productos", flush=True)

    products = []
    for p in raw_products[:limit]:
        # Precio — CJ devuelve en USD, estimamos EUR (×0.92)
        price_usd = float(p.get("sellPrice") or p.get("nowPrice") or 0)
        price_eur = round(price_usd * 0.92, 2)

        # Calcular margen estimado (precio venta sugerido = 3x coste)
        suggested_price = round(price_eur * 3, 2)
        margin_pct      = round((1 - 1/3) * 100)  # ~66%

        products.append({
            "product_id":       p.get("id", ""),
            "sku":              p.get("sku", ""),
            "title":            (p.get("productNameEn") or p.get("productName") or p.get("nameEn") or "")[:120],
            "price_usd":        price_usd,
            "price_eur":        price_eur,
            "suggested_price_eur": suggested_price,
            "est_margin_pct":   margin_pct,
            "image_url":        p.get("productImage") or p.get("bigImage") or "",
            "category":         p.get("threeCategoryName") or p.get("oneCategoryName", ""),
            "inventory":        p.get("warehouseInventoryNum") or p.get("totalVerifiedInventory", 0),
            "listings":         p.get("listedNum", 0),
            "cj_url":           f"https://www.cjdropshipping.com/product/-p-{p.get('id', '')}.html",
            "source":           "cj_dropshipping",
        })

    return products


# ── Input parser ──────────────────────────────────────────────────────────────

def parse_input(raw: str) -> dict:
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
    # Limpiar niche: tomar solo primera línea significativa
    first_line = raw.strip().splitlines()[0] if raw.strip() else ""
    return {"query": first_line or "trending products", "limit": 10}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    api_key = os.environ.get("CJ_API_KEY", "").strip()
    if not api_key:
        post_issue_result("❌ CJ Scraper: CJ_API_KEY no configurada en Railway.")
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    if not raw:
        raw = "dog led collar"

    params  = parse_input(raw)
    query   = params["query"]
    limit   = params["limit"]

    post_issue_comment(f"🛒 CJ Scraper buscando productos reales: **{query}**")
    print(f"🛒 CJ Dropshipping Search: '{query}' | Limit: {limit}", flush=True)

    try:
        token    = get_access_token(api_key)
        products = search_products(query, token, limit=limit)
    except Exception as e:
        error_msg = f"❌ CJ Scraper error: {e}"
        print(error_msg, file=sys.stderr)
        post_issue_result(error_msg)
        sys.exit(1)

    if not products:
        post_issue_result(
            f"⚠️ CJ Scraper: sin resultados para '{query}'.\n"
            f"Prueba con términos en inglés (ej: 'dog led collar', 'pet harness')."
        )
        return

    print(f"✅ {len(products)} productos extraídos de CJ", flush=True)

    # Output formateado
    lines = [f"# 🛒 CJ DROPSHIPPING — {query}\n"]
    lines.append(f"**{len(products)} productos reales** del proveedor\n")

    for i, p in enumerate(products, 1):
        inv_badge = f"📦 {p['inventory']} uds" if p['inventory'] else ""
        lines.append(f"## {i}. {p['title']}")
        lines.append(f"- 💶 Coste: **${p['price_usd']:.2f} USD** (≈€{p['price_eur']:.2f})")
        lines.append(f"- 🏷️ Venta sugerida: **€{p['suggested_price_eur']:.2f}** | Margen: ~{p['est_margin_pct']}%")
        lines.append(f"- 📂 Categoría: {p['category']} {inv_badge}")
        if p['image_url']:
            lines.append(f"- 🖼️ ![{p['title'][:30]}]({p['image_url']})")
        lines.append(f"- 🔗 [Ver en CJ]({p['cj_url']})")
        lines.append("")

    # JSON slim para el pipeline
    slim = [
        {
            "name":                  p["title"],
            "price_eur":             p["price_eur"],
            "suggested_price_eur":   p["suggested_price_eur"],
            "est_margin_pct":        p["est_margin_pct"],
            "image_url":             p["image_url"],
            "cj_url":                p["cj_url"],
            "sku":                   p["sku"],
            "source":                "cj_dropshipping",
        }
        for p in products
    ]
    output_json = {"products": slim, "query": query, "total": len(products)}
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
