"""
Agente: CEO — DiscontrolDrops Orchestrator
Coordina el pipeline de investigación y lanzamiento de productos.

ARQUITECTURA: CEO como traductor estricto.
Cada agente recibe un JSON pequeño con SOLO los campos que necesita.
No se pasa nunca texto crudo ni outputs completos entre agentes.

Flujo:
1. Product Hunter  → input: {niche, region}
                   → output parsed: lista de productos slim
2. Ad Spy          → input: {products: [{name}], niche}
                   → output parsed: lista de ad_results
3. Lead Qualifier  → input: {products, ad_results, niche}
                   → output parsed: producto ganador (LAUNCH/TEST) normalizado
4. Web Designer    → input: winner JSON exacto
5. Marketing Creator → input: winner JSON exacto (mismo que Web Designer)
"""
import os
import sys
import json
import re
import time
import hmac
import hashlib
import base64
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")


def fetch_serper_images(product_name: str, num: int = 5) -> list:
    """
    Busca imágenes del producto en Google via Serper API.
    Devuelve lista de URLs de imágenes reales del producto.
    Serper: https://serper.dev — 2500 búsquedas gratis/mes
    """
    serper_key = os.environ.get("SERPER_API_KEY", "").strip()
    if not serper_key:
        return []

    try:
        payload = json.dumps({
            "q":  product_name,
            "gl": "es",
            "hl": "es",
            "num": num,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://google.serper.dev/images",
            data=payload,
            headers={
                "X-API-KEY":    serper_key,
                "Content-Type": "application/json",
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))

        images = data.get("images", [])
        urls   = [img["imageUrl"] for img in images if img.get("imageUrl")]
        print(f"  🔍 Serper: {len(urls)} imágenes para '{product_name[:40]}'", flush=True)
        return urls[:num]

    except Exception as e:
        print(f"  ⚠️  Serper error: {e}", flush=True)
        return []


def fetch_cj_image_for_winner(winner_name: str) -> str:
    """
    Búsqueda dirigida en CJ para obtener imagen del producto ganador.
    Usa el nombre exacto del winner — más preciso que la búsqueda por nicho.
    """
    cj_key = os.environ.get("CJ_API_KEY", "").strip()
    if not cj_key:
        return ""

    CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1"

    # Auth
    try:
        payload = json.dumps({"apiKey": cj_key}).encode("utf-8")
        req = urllib.request.Request(
            f"{CJ_BASE}/authentication/getAccessToken",
            data=payload, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            auth = json.loads(r.read().decode("utf-8"))
        if not auth.get("result"):
            return ""
        token = auth["data"]["accessToken"]
    except Exception:
        return ""

    # Traducir nombre del winner a inglés para CJ
    kw_map = {
        "enfriador": "cooler", "portátil": "portable", "smartphone": "phone",
        "inteligente": "smart", "gafas": "glasses", "smartwatch": "smartwatch",
        "soporte": "stand", "auricular": "headphone", "teclado": "keyboard",
        "ratón": "mouse", "webcam": "webcam", "lampara": "lamp",
        "altavoz": "speaker", "cargador": "charger", "cable": "cable",
        "para movil": "phone", "gaming": "gaming", "rgb": "rgb",
    }
    query = winner_name.lower()
    for es, en in kw_map.items():
        query = query.replace(es, en)
    # Quitar stopwords y tomar primeras 4 palabras
    stopwords = {"para", "con", "de", "del", "anti", "y", "el", "la", "los", "las"}
    words = [w for w in query.split() if w not in stopwords and len(w) > 2]
    query = " ".join(words[:4])

    # Buscar en CJ
    try:
        params = urllib.parse.urlencode({"keyWord": query, "pageNum": 1, "pageSize": 5})
        req = urllib.request.Request(
            f"{CJ_BASE}/product/list?{params}",
            headers={"CJ-Access-Token": token, "Accept": "application/json"}, method="GET"
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))

        if not data.get("result"):
            return ""

        products = data.get("data", {}).get("list", [])
        # Extraer keywords del winner para validar relevancia
        winner_words = set(w.lower() for w in winner_name.split() if len(w) > 3)
        # Excluir stopwords comunes
        stopwords = {"para", "con", "portátil", "portatil", "inteligente", "generación",
                     "modelo", "versión", "anti", "ultra", "mini", "pro", "plus"}
        winner_words -= stopwords

        for p in products:
            img      = p.get("productImage") or p.get("bigImage") or ""
            p_name   = (p.get("productNameEn") or p.get("productName") or "").lower()
            if not img or not img.startswith("http"):
                continue
            # Validar que el producto CJ tiene alguna relación con el winner
            if winner_words and not any(w in p_name for w in winner_words):
                print(f"  ⚠️  CJ product '{p_name[:40]}' no relacionado con winner — skip", flush=True)
                continue
            print(f"  🖼️  CJ imagen para winner '{winner_name[:30]}': {img[:60]}", flush=True)
            return img
    except Exception as e:
        print(f"  ⚠️  CJ winner image search: {e}", flush=True)

    return ""
sys.stderr.reconfigure(encoding="utf-8")

# ── Agent IDs — DiscontrolDrops ───────────────────────────────────────────────
AGENT_IDS = {
    "product_hunter":    "01a671f6-a303-4f74-90e2-914c63a2e34d",
    "ad_spy":            "9d3649ad-b902-495a-8330-8048d94ac20d",
    "lead_qualifier":    "fbf55d11-03cb-4d88-9132-7a04a9091d8c",
    "web_designer":      "e39f154b-0415-42f2-bd60-b79f66ecaca7",
    "marketing_creator": "f6fb0f5a-ea32-4a29-aac1-95e7c3db6335",
}


# ── Auth ──────────────────────────────────────────────────────────────────────

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(agent_id: str, company_id: str, run_id: str, secret: str) -> str:
    now     = int(time.time())
    header  = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":"))
    payload = json.dumps({
        "sub": agent_id, "company_id": company_id,
        "adapter_type": "process", "run_id": run_id,
        "iat": now, "exp": now + 172800,
        "iss": "paperclip", "aud": "paperclip-api",
    }, separators=(",", ":"))
    si  = f"{b64url(header.encode())}.{b64url(payload.encode())}"
    sig = hmac.new(secret.encode(), si.encode(), hashlib.sha256).digest()
    return f"{si}.{b64url(sig)}"


def api_request(method: str, url: str, payload, headers: dict):
    try:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req  = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        print(f"  ⚠️  API {method} → HTTP {e.code}: {body[:300]}", flush=True)
        return None
    except Exception as e:
        print(f"  ⚠️  API {method} → {e}", flush=True)
        return None


# ── Issue helpers ─────────────────────────────────────────────────────────────

def get_project_id(api_url: str, company_id: str, headers: dict,
                   name: str = "product 1") -> str:
    try:
        result   = api_request("GET", f"{api_url}/api/companies/{company_id}/projects",
                               None, headers)
        projects = result if isinstance(result, list) else (result or {}).get("projects", [])
        for p in projects:
            if isinstance(p, dict) and name.lower() in p.get("name", "").lower():
                return p.get("id", "")
    except Exception as e:
        print(f"  ⚠️  get_project_id: {e}", flush=True)
    return ""


def create_sub_issue(title: str, description: str, agent_key: str,
                     parent_id: str, api_url: str, company_id: str,
                     headers: dict, project_id: str = "") -> str | None:
    agent_id = AGENT_IDS.get(agent_key, "")
    payload: dict = {"title": title, "status": "todo", "parentId": parent_id}
    if project_id:
        payload["projectId"] = project_id
    if description:
        payload["description"] = description[:8000]
    if agent_id:
        payload["assigneeAgentId"] = agent_id
    result = api_request("POST", f"{api_url}/api/companies/{company_id}/issues",
                         payload, headers)
    if result:
        sub_id = result.get("id") or result.get("issue", {}).get("id")
        if sub_id:
            print(f"  ✅ Sub-issue '{title}' → {sub_id}", flush=True)
            return sub_id
    print(f"  ⚠️  No se pudo crear sub-issue: {result}", flush=True)
    return None


def wait_for_issue(sub_id: str, api_url: str, headers: dict,
                   max_wait: int = 300) -> str:
    deadline = time.time() + max_wait
    time.sleep(8)
    while time.time() < deadline:
        data   = api_request("GET", f"{api_url}/api/issues/{sub_id}", None, headers)
        status = (data or {}).get("status", "")
        print(f"  ⏳ {sub_id[:8]}… → {status}", flush=True)
        if status == "done":
            time.sleep(2)
            comments = api_request(
                "GET", f"{api_url}/api/issues/{sub_id}/comments?limit=20", None, headers
            )
            if comments:
                items = (comments if isinstance(comments, list)
                         else comments.get("comments") or comments.get("items") or [])
                if items:
                    result_comments = [c for c in items if len(c.get("body", "") or "") > 200]
                    best = (result_comments[0] if result_comments
                            else max(items, key=lambda c: len(c.get("body", "") or "")))
                    body = best.get("body", "") or ""
                    print(f"  📨 Resultado: {len(body)} chars", flush=True)
                    return body
            return ""
        if status in ("cancelled", "failed"):
            return ""
        time.sleep(8)
    print(f"  ⏰ Timeout {sub_id}", flush=True)
    return ""


# ── Input/Output parsers (traducción estricta) ────────────────────────────────

def parse_niche(raw: str) -> str:
    """Extrae solo el nicho limpio del input del usuario."""
    try:
        data = json.loads(raw)
        return data.get("niche", data.get("query", raw.strip()))
    except Exception:
        pass
    for line in raw.strip().splitlines():
        line = line.strip()
        if line.lower().startswith("nicho:"):
            return line.split(":", 1)[1].strip()
        if line and not line.lower().startswith((
            "region", "región", "precio", "temporada", "presupuesto",
            "busca", "queremos", "nicho de", "#", "---"
        )):
            # Limpiar descriptores adicionales después de em dash o paréntesis
            clean = line.split("—")[0].split("(")[0].split("-")[0].strip()
            if len(clean) > 3:
                return clean
    return raw.strip()[:80] or "trending products"


def parse_hunter_output(result: str) -> list:
    """Extrae lista limpia de productos del Product Hunter."""
    try:
        # Buscar bloque JSON con "products"
        if "```json" in result:
            for block in reversed(result.split("```json")[1:]):
                candidate = block.split("```")[0].strip()
                try:
                    data = json.loads(candidate)
                    if "products" in data:
                        return _slim_products(data["products"])
                except Exception:
                    continue
        # Buscar JSON crudo
        m = re.search(r'\{"products"[\s\S]*?\}(?=\s*$|\s*```)', result)
        if m:
            data = json.loads(m.group(0))
            return _slim_products(data.get("products", []))
    except Exception as e:
        print(f"  ⚠️  parse_hunter_output: {e}", flush=True)
    return []


def _slim_products(prods: list) -> list:
    """Reduce productos a campos esenciales para el pipeline."""
    result = []
    for p in prods[:10]:
        name = p.get("name", "")
        if not name:
            continue
        result.append({
            "name":                  name,
            "score":                 int(p.get("score", 0) or 0),
            "est_margin_pct":        p.get("est_margin_pct", 0),
            "competition":           p.get("competition", "Med"),
            "suggested_price_eur":   p.get("suggested_price_eur", 0),
            "supplier_est_cost_eur": p.get("supplier_est_cost_eur", 0),
            "why":                   str(p.get("why", ""))[:100],
            "target_audience":       str(p.get("target_audience", ""))[:80],
            "yt_demand":             p.get("yt_demand", "unknown"),
            # Imagen real del proveedor CJ — fluye hasta el Web Designer
            "image_url":             p.get("image_url", ""),
            "cj_url":                p.get("cj_url", ""),
        })
    return result


def parse_spy_output(result: str) -> list:
    """Extrae resultados del Ad Spy (solo campos relevantes)."""
    try:
        if "```json" in result:
            for block in reversed(result.split("```json")[1:]):
                candidate = block.split("```")[0].strip()
                try:
                    data = json.loads(candidate)
                    if "results" in data:
                        return [
                            {
                                "product":    r.get("product", ""),
                                "total_ads":  r.get("total_ads", 0),
                                "validated":  r.get("validated", False),
                                "score":      r.get("evidence_score", 0),
                            }
                            for r in data["results"][:6]
                        ]
                except Exception:
                    continue
    except Exception as e:
        print(f"  ⚠️  parse_spy_output: {e}", flush=True)
    return []


def parse_qualifier_output(result: str) -> dict | None:
    """
    Extrae el producto ganador (LAUNCH > TEST, nunca SKIP).
    Devuelve dict normalizado con todos los campos que necesitan
    Web Designer y Marketing Creator.
    """
    candidates = []
    try:
        if "```json" in result:
            for block in reversed(result.split("```json")[1:]):
                candidate_str = block.split("```")[0].strip()
                try:
                    data = json.loads(candidate_str)
                    if "qualified" in data:
                        candidates = data["qualified"]
                        break
                    if "products" in data:
                        candidates = data["products"]
                        break
                except Exception:
                    continue
        if not candidates:
            m = re.search(r'\{"qualified"[\s\S]*?\}(?=\s*$)', result)
            if m:
                data = json.loads(m.group(0))
                candidates = data.get("qualified", [])
    except Exception as e:
        print(f"  ⚠️  parse_qualifier_output JSON: {e}", flush=True)

    # Ordenar: LAUNCH primero, TEST después, SKIP rechazado
    def priority(p):
        rec = str(p.get("recommendation", "")).upper()
        if rec == "LAUNCH": return 0
        if rec == "TEST":   return 1
        return 99

    candidates.sort(key=priority)

    for p in candidates:
        rec   = str(p.get("recommendation", "")).upper()
        score = int(p.get("final_score", p.get("score", 0)) or 0)
        if rec == "SKIP" or score < 10:
            continue
        name = p.get("name", "")
        if not name:
            continue
        # Precio: usar el del qualifier si existe, si no del producto original
        raw_price = p.get("suggested_price_eur") or p.get("suggested_price") or 0
        try:
            price = float(str(raw_price).split("--")[0].strip())
        except Exception:
            price = 0.0

        raw_cost = p.get("supplier_cost_eur") or p.get("supplier_est_cost_eur") or 0
        try:
            cost = float(str(raw_cost).split("--")[0].strip())
        except Exception:
            cost = 0.0

        # Si el qualifier no dio precio, calcular desde coste (3x markup)
        if price <= 1 and cost > 0:
            price = round(cost * 3, 2)
        elif price <= 1:
            price = 29.99  # fallback solo si no hay nada

        margin = p.get("est_margin_pct", 0)
        if not margin and cost > 0 and price > 0:
            margin = round((1 - cost / price) * 100)
        elif not margin:
            margin = 60

        return {
            "name":                name,
            "score":               score,
            "recommendation":      rec,
            "suggested_price_eur": price,
            "supplier_cost_eur":   cost,
            "est_margin_pct":      margin,
            "key_strength":        str(p.get("key_strength", ""))[:150],
            "main_risk":           str(p.get("main_risk", ""))[:150],
            "suggested_hook":      str(p.get("suggested_hook", ""))[:100],
            "target_audience":     str(p.get("target_audience", "adultos 25-45"))[:100],
        }
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    api_url    = os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100").rstrip("/")
    agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "")
    company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
    run_id     = os.environ.get("PAPERCLIP_RUN_ID", "")
    issue_id   = os.environ.get("PAPERCLIP_ISSUE_ID", "")
    api_key    = os.environ.get("PAPERCLIP_API_KEY", "")
    jwt_secret = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or
                  os.environ.get("BETTER_AUTH_SECRET", "")).strip()

    headers: dict = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    elif jwt_secret and agent_id and run_id:
        token = make_jwt(agent_id, company_id, run_id, jwt_secret)
        headers["Authorization"] = f"Bearer {token}"
    elif jwt_secret and agent_id:
        token = make_jwt(agent_id, company_id, "", jwt_secret)
        headers["Authorization"] = f"Bearer {token}"

    issue_title, issue_body = resolve_issue_context()
    raw   = issue_body if issue_body else (issue_title or "")
    niche = parse_niche(raw)

    project_id = get_project_id(api_url, company_id, headers, "product 1")

    print(f"🚀 CEO DROPS — Nicho: '{niche}'", flush=True)
    post_issue_comment(
        f"🚀 **CEO DiscontrolDrops** iniciando para: **{niche}**\n\n"
        f"Pipeline: Product Hunter → Ad Spy → Lead Qualifier → Web Designer → Marketing Creator"
    )

    # ── PASO 1: Product Hunter ────────────────────────────────────────────────
    post_issue_comment("🔍 **Paso 1/5** — Buscando productos ganadores...")
    hunter_input = json.dumps({"niche": niche, "region": "ES", "limit": 10},
                              ensure_ascii=False)
    hunter_id = create_sub_issue(
        f"Product Hunt: {niche}", hunter_input,
        "product_hunter", issue_id, api_url, company_id, headers, project_id
    )
    if not hunter_id:
        post_issue_result("❌ No se pudo crear issue de Product Hunter.")
        return
    hunter_result = wait_for_issue(hunter_id, api_url, headers, max_wait=300)
    if not hunter_result:
        post_issue_result("❌ Product Hunter no completó.")
        return

    products = parse_hunter_output(hunter_result)
    print(f"  📦 Productos extraídos: {len(products)} | {[p['name'][:30] for p in products[:3]]}",
          flush=True)
    if not products:
        post_issue_result(f"❌ Product Hunter no devolvió productos para: {niche}")
        return

    # ── PASO 2: Ad Spy ────────────────────────────────────────────────────────
    post_issue_comment("🕵️ **Paso 2/5** — Validando demanda...")
    spy_input = json.dumps({
        "products": [{"name": p["name"]} for p in products[:6]],
        "niche":    niche,
    }, ensure_ascii=False)
    spy_id     = create_sub_issue(
        f"Ad Spy: {niche}", spy_input,
        "ad_spy", issue_id, api_url, company_id, headers, project_id
    )
    spy_result = wait_for_issue(spy_id, api_url, headers, max_wait=180) if spy_id else ""
    ad_results = parse_spy_output(spy_result) if spy_result else []
    print(f"  📦 Ad results: {len(ad_results)}", flush=True)

    # ── PASO 3: Lead Qualifier ────────────────────────────────────────────────
    post_issue_comment("🎯 **Paso 3/5** — Calificando productos...")
    qualifier_input = json.dumps({
        "products":   products,
        "ad_results": ad_results,
        "niche":      niche,
    }, ensure_ascii=False)
    qualifier_id = create_sub_issue(
        f"Qualify: {niche}", qualifier_input,
        "lead_qualifier", issue_id, api_url, company_id, headers, project_id
    )
    if not qualifier_id:
        post_issue_result("❌ No se pudo crear issue de Lead Qualifier.")
        return
    qualifier_result = wait_for_issue(qualifier_id, api_url, headers, max_wait=180)
    if not qualifier_result:
        post_issue_result("❌ Lead Qualifier no completó.")
        return

    winner = parse_qualifier_output(qualifier_result)
    if not winner:
        post_issue_result(
            f"# ⚠️ Sin producto ganador para: **{niche}**\n\n"
            f"El Lead Qualifier descartó todos los productos.\n\n"
            f"Prueba un nicho más específico como:\n"
            f"- `{niche} eléctrico portátil`\n"
            f"- `{niche} para verano España`\n\n"
            f"Output del qualifier:\n```\n{qualifier_result[:400]}\n```"
        )
        return

    winner_name = winner["name"]

    # ── Búsqueda de imágenes reales del producto ─────────────────────────────
    # Prioridad 1: Serper (Google Images) — imágenes reales del producto exacto
    if not winner.get("image_url") or not winner["image_url"].startswith("http"):
        serper_imgs = fetch_serper_images(winner_name, num=5)
        if serper_imgs:
            winner["image_url"]       = serper_imgs[0]
            winner["extra_image_urls"] = serper_imgs[1:]
            print(f"  🖼️  Serper: {len(serper_imgs)} imágenes para '{winner_name[:40]}'", flush=True)

    # Prioridad 2: CJ directo si Serper no encontró nada
    if not winner.get("image_url") or not winner["image_url"].startswith("http"):
        cj_img = fetch_cj_image_for_winner(winner_name)
        if cj_img:
            winner["image_url"] = cj_img

    # Recuperar image_url: 1) del qualifier output, 2) fuzzy match, 3) top CJ product
    if not winner.get("image_url") or not winner["image_url"].startswith("http"):
        # Intento 1: fuzzy match por nombre
        for p in products:
            if p.get("image_url") and p["image_url"].startswith("http") and (
                p["name"].lower()[:30] in winner_name.lower() or
                winner_name.lower()[:30] in p["name"].lower()
            ):
                winner["image_url"] = p["image_url"]
                winner["cj_url"]    = p.get("cj_url", "")
                print(f"  🖼️  Imagen CJ (fuzzy match): {winner['image_url'][:60]}", flush=True)
                break

        # Intento 2: tomar la imagen del primer producto CJ disponible
        if not winner.get("image_url") or not winner["image_url"].startswith("http"):
            for p in products:
                if p.get("image_url") and p["image_url"].startswith("http") and p.get("source") == "cj_dropshipping":
                    winner["image_url"] = p["image_url"]
                    winner["cj_url"]    = p.get("cj_url", "")
                    print(f"  🖼️  Imagen CJ (primer CJ disponible): {winner['image_url'][:60]}", flush=True)
                    break

    print(f"  🏆 Ganador: {winner_name} (score={winner['score']}, rec={winner['recommendation']})",
          flush=True)

    # winner_json = input exacto para Web Designer y Marketing Creator
    winner_json = json.dumps(winner, ensure_ascii=False)

    # ── PASO 4: Web Designer ──────────────────────────────────────────────────
    post_issue_comment(f"🎨 **Paso 4/5** — Generando landing para: **{winner_name}**")
    web_id     = create_sub_issue(
        f"Web Design: {winner_name}", winner_json,
        "web_designer", issue_id, api_url, company_id, headers, project_id
    )
    web_result = wait_for_issue(web_id, api_url, headers, max_wait=300) if web_id else ""

    # ── PASO 5: Marketing Creator ─────────────────────────────────────────────
    post_issue_comment(f"📣 **Paso 5/5** — Generando assets para: **{winner_name}**")
    mkt_id     = create_sub_issue(
        f"Marketing: {winner_name}", winner_json,
        "marketing_creator", issue_id, api_url, company_id, headers, project_id
    )
    mkt_result = wait_for_issue(mkt_id, api_url, headers, max_wait=180) if mkt_id else ""

    # ── Resumen ───────────────────────────────────────────────────────────────
    preview_url = ""
    m_preview   = re.search(r'https://[^\s\]]+/preview/\w+', web_result or "")
    if m_preview:
        preview_url = m_preview.group(0)

    post_issue_result(
        f"# ✅ DiscontrolDrops — Pipeline Completado\n\n"
        f"**Producto:** {winner_name}\n"
        f"**Score:** {winner['score']} | **{winner['recommendation']}**\n"
        f"**Precio:** €{winner.get('suggested_price_eur','?')} | "
        f"Margen: {winner.get('est_margin_pct','?')}%\n"
        f"**Hook:** _{winner.get('suggested_hook','')}_\n\n"
        + (f"## 🌐 Preview Landing\n**[Ver → {preview_url}]({preview_url})**\n\n"
           if preview_url else "") +
        f"## 🎯 Calificación\n{qualifier_result[:600]}\n\n"
        f"## 📣 Marketing\n{(mkt_result or '_No generado_')[:500]}"
    )


if __name__ == "__main__":
    main()
