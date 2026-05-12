"""
Agente: Web Designer — DiscontrolDrops
Genera landing page completa + HTML preview visual en Railway.
El preview se puede ver, editar y luego publicar en Shopify.
"""
import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm, fetch_skill
sys.stdout.reconfigure(encoding="utf-8")

DROPS_COMPANY  = "0b4751e7-24e7-4e8b-98e0-5b5ed73b6d7c"
REFERENCE_FILE = __import__("pathlib").Path(__file__).parent / "reference_landings.md"
PEXELS_API     = "https://api.pexels.com/v1/search"


def load_reference_landings() -> str:
    """Carga el archivo de referencia de landings de alta conversión."""
    try:
        content = REFERENCE_FILE.read_text(encoding="utf-8")
        print(f"  ✅ Reference landings cargado ({len(content)} chars)", flush=True)
        return content
    except Exception as e:
        print(f"  ⚠️  No se pudo cargar reference_landings.md: {e}", flush=True)
        return ""


def fetch_openverse_images(product_name: str) -> dict:
    """
    Busca imágenes relevantes en Openverse (WordPress Foundation).
    - Sin API key requerida
    - Funciona desde cualquier IP incluyendo Railway
    - Busca por keyword → fotos reales relacionadas con el producto
    - Licencias Creative Commons (uso libre)
    API: https://api.openverse.org/v1/images/?q=QUERY
    """
    # Detectar categoría y usar query en inglés (Openverse solo funciona bien en inglés)
    name_lower = product_name.lower()
    category_queries = [
        (["coche", "auto", "vehiculo", "consola central", "organizador coche"], "car interior organizer accessory"),
        (["perro", "mascota", "pet", "collar", "arnes", "arnés", "correa"], "dog pet accessory"),
        (["gato", "felino"], "cat pet accessory"),
        (["humidificador", "humidifier", "aroma", "difusor"], "humidifier room home"),
        (["laptop", "portatil", "portátil", "soporte laptop", "soporte ordenador"], "laptop stand desk"),
        (["mochila", "backpack", "bolsa viaje"], "backpack travel bag"),
        (["cocina", "kitchen", "blender", "licuadora"], "kitchen gadget cooking"),
        (["fitness", "gym", "banda", "ejercicio", "deporte", "pistola masaje", "masaje muscular"], "fitness workout equipment"),
        (["masaje facial", "mascarilla", "skincare", "serum", "crema", "led facial", "rejuvenecimiento"], "skincare beauty facial"),
        # Gaming — incluye marcas conocidas
        (["gaming", "consola", "retro", "game", "anbernic", "rg35", "powkiddy",
          "retroid", "emulador", "juegos retro", "portatil juegos"], "retro handheld gaming console"),
        (["led", "luz", "lampara", "ring light"], "led light product"),
        (["soporte movil", "soporte telefono", "magsafe", "magnético", "soporte coche"], "phone holder car mount"),
        (["joya", "collar joya", "pulsera", "anillo", "colgante", "jesus piece"], "jewelry necklace accessories"),
        (["manta", "almohada", "cojin"], "home textile comfort"),
        (["ps5", "playstation", "xbox", "nintendo", "switch"], "gaming console accessories"),
        (["auricular", "cascos", "earbuds", "bluetooth audio"], "wireless earbuds headphones"),
        (["gafas", "smartglass", "ar glass", "camara gafas"], "smart glasses technology wearable"),
        (["smartwatch", "reloj inteligente", "wearable", "pulsera"], "smartwatch fitness wearable"),
        (["dron", "drone", "quadcopter"], "drone flying technology"),
        (["impresora 3d", "3d print"], "3d printer technology"),
    ]
    query = "tech gadget product lifestyle"  # default más específico
    for keywords, english_query in category_queries:
        if any(kw in name_lower for kw in keywords):
            query = english_query
            break
    print(f"  🔍 Openverse query: '{query}'", flush=True)

    try:
        params = urllib.parse.urlencode({
            "q":         query,
            "page_size": 6,
        })
        req = urllib.request.Request(
            f"https://api.openverse.org/v1/images/?{params}",
            headers={
                "User-Agent": "DiscontrolDrops/1.0 (dropshipping tool)",
                "Accept":     "application/json",
            },
            method="GET"
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))

        results = data.get("results", [])
        urls = [r["url"] for r in results if r.get("url")]

        if urls:
            print(f"  ✅ Openverse: {len(urls)} imágenes relevantes para '{query}'", flush=True)
            return {
                "hero":    urls[:1],
                "product": urls[1:4],
                "context": urls[4:6],
                "all":     urls,
            }
    except Exception as e:
        print(f"  ⚠️  Openverse error: {e}", flush=True)

    # Último fallback: Picsum con seed consistente
    import hashlib
    base_seed = int(hashlib.md5(product_name.encode()).hexdigest(), 16) % 1000
    urls = [f"https://picsum.photos/seed/{base_seed + i}/800/600" for i in range(6)]
    print(f"  ℹ️  Picsum fallback (seed {base_seed})", flush=True)
    return {"hero": urls[:1], "product": urls[1:4], "context": urls[4:6], "all": urls}


def fetch_pexels_images(product_name: str, pexels_key: str) -> dict:
    """
    Busca imágenes en Pexels para el producto.
    Devuelve dict con URLs para hero, product_shots y lifestyle.

    Pexels API: GET /v1/search?query=...&per_page=N&orientation=landscape
    Auth: Authorization: {API_KEY}  (sin Bearer)
    """
    if not pexels_key:
        print("  ⚠️  PEXELS_API_KEY no configurada — sin imágenes", flush=True)
        return {}

    def search(query: str, count: int = 3, orientation: str = "landscape") -> list:
        try:
            params = urllib.parse.urlencode({
                "query":       query,
                "per_page":    count,
                "orientation": orientation,
            })
            req = urllib.request.Request(
                f"{PEXELS_API}?{params}",
                headers={"Authorization": pexels_key, "Accept": "application/json"},
                method="GET"
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode("utf-8"))
            photos = data.get("photos", [])
            return [p["src"]["large"] for p in photos if p.get("src", {}).get("large")]
        except Exception as e:
            print(f"  ⚠️  Pexels search '{query}': {e}", flush=True)
            return []

    # Extraer keywords del nombre del producto
    # Ej: "Arnés de paso para perros pequeños" → "dog harness small breed"
    name_lower = product_name.lower()
    keywords   = product_name

    # Queries específicas por tipo de producto detectado
    hero_query    = f"{keywords} lifestyle"
    product_query = f"{keywords}"
    context_query = f"{keywords} person using"

    # Detectar contexto del producto para queries más precisas
    if any(w in name_lower for w in ["perro", "dog", "mascota", "pet", "gato", "cat"]):
        hero_query    = "dog owner happy outdoors"
        product_query = f"{keywords} product"
        context_query = "cute small dog walking"
    elif any(w in name_lower for w in ["cocina", "kitchen", "gadget", "comida", "food"]):
        hero_query    = "modern kitchen cooking"
        product_query = f"{keywords}"
        context_query = "person cooking kitchen"
    elif any(w in name_lower for w in ["fitness", "gym", "banda", "ejercicio", "deporte"]):
        hero_query    = "fitness home workout"
        product_query = f"{keywords}"
        context_query = "person exercising home"
    elif any(w in name_lower for w in ["belleza", "beauty", "crema", "serum", "skincare"]):
        hero_query    = "skincare beauty routine"
        product_query = f"{keywords}"
        context_query = "woman skincare applying"

    hero_urls    = search(hero_query,    count=2, orientation="landscape")
    product_urls = search(product_query, count=3, orientation="landscape")
    context_urls = search(context_query, count=2, orientation="landscape")

    all_urls = {
        "hero":     hero_urls[:1],
        "product":  product_urls[:3],
        "context":  context_urls[:2],
        "all":      (hero_urls + product_urls + context_urls)[:6],
    }

    total = len(all_urls["all"])
    print(f"  ✅ Pexels: {total} imágenes ({len(hero_urls)} hero + "
          f"{len(product_urls)} producto + {len(context_urls)} contexto)", flush=True)
    return all_urls

STRUCTURE_SYSTEM = """Eres experto en CRO para Shopify en el mercado español.
Generas landing pages de alto rendimiento para dropshipping.
Todo en español, orientado al consumidor español: directo, garantías claras, sin exageraciones.
Cuando se te proporcionan datos de competidores reales, úsalos como base — replica lo que ya convierte
y mejóralo con mejor copy y estructura más clara.

REGLAS DE CREDIBILIDAD (críticas para convertir en España):
1. PRECIO ANCLA REALISTA — el precio tachado debe ser máximo 2x el precio actual, nunca más.
   ❌ MAL: ~~€279.99~~ → €69.99 (parece fake)
   ✅ BIEN: ~~€99.99~~ → €64.99 (creíble)
2. DESCUENTO MÁXIMO 40% — descuentos del 70-80% destruyen credibilidad.
3. SIN CLAIMS MÉDICOS SIN FUENTE — evita "200% más colágeno", "probado clínicamente" sin citar fuente.
   Usa en cambio: "miles de clientes notan la diferencia en 2 semanas".
4. URGENCIA CREÍBLE — si pones stock limitado, que sea coherente con el producto (no siempre 47 unidades).
   Mejor: "Oferta válida hasta agotar stock" o un descuento temporal.
5. GARANTÍA ESPECÍFICA — "30 días sin preguntas, devolución del 100%" es mejor que promesas vagas."""

HTML_SYSTEM = """Eres un desarrollador frontend experto en landing pages de Shopify para el mercado español.
Generas HTML/CSS completo, limpio y visual de una landing page de dropshipping.
El resultado debe verse profesional y listo para convertir.

REGLAS:
- HTML completo con <style> embebido (no CDN externos salvo Google Fonts)
- Diseño dark/moderno o claro según el producto
- Mobile-first, responsive
- Botones CTA en color llamativo (naranja o verde)
- Incluir sección hero, beneficios, reseñas, garantía y CTA final
- Usar los textos exactos que se te proporcionen
- Todo en español
- SIEMPRE incluir un countdown timer funcional en JavaScript que cuente desde 23:59:00 hacia atrás
  con este formato: <div id="timer">23:59:00</div> y el JS que lo hace funcionar
- El precio tachado NUNCA debe ser más del doble del precio actual"""


def scrape_competitor_landings(product_name: str, max_pages: int = 3) -> str:
    """
    Busca en Google tiendas Shopify que venden el producto y scrapea sus landings.
    Extrae: headline, estructura, CTAs, precio, badges.
    Devuelve un resumen de patrones de conversión detectados.
    """
    HEADERS = {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "es-ES,es;q=0.9",
        "Accept":          "text/html,*/*",
    }

    # Buscar tiendas Shopify del producto en Google
    queries = [
        f'"{product_name}" comprar tienda online España site:*.myshopify.com',
        f'"{product_name}" comprar "añadir al carrito" -amazon -aliexpress',
        f'{product_name} dropshipping tienda online "envío gratis"',
    ]

    competitor_urls = []
    for query in queries[:2]:
        try:
            url = f"https://www.google.es/search?q={urllib.parse.quote(query)}&num=5&hl=es"
            req = urllib.request.Request(url, headers=HEADERS, method="GET")
            with urllib.request.urlopen(req, timeout=12) as r:
                html = r.read().decode("utf-8", errors="replace")

            # Extraer URLs de resultados
            for m in re.finditer(r'href="(https?://(?!google|youtube|amazon|aliexpress|facebook)[^"]{10,80})"', html):
                u = m.group(1)
                if u not in competitor_urls and not any(x in u for x in ["google", "cache:", "translate"]):
                    competitor_urls.append(u)
                if len(competitor_urls) >= max_pages * 2:
                    break
        except Exception as e:
            print(f"  ⚠️  Google search error: {e}", flush=True)

    if not competitor_urls:
        return ""

    print(f"  🌐 Scrapeando {min(len(competitor_urls), max_pages)} páginas de competidores...", flush=True)

    insights = []
    for url in competitor_urls[:max_pages]:
        try:
            req = urllib.request.Request(url, headers=HEADERS, method="GET")
            with urllib.request.urlopen(req, timeout=10) as r:
                html = r.read().decode("utf-8", errors="replace")

            # Extraer elementos clave de conversión
            # 1. Headlines (h1, h2)
            headlines = re.findall(r'<h[12][^>]*>([^<]{5,120})</h[12]>', html)
            headlines = [re.sub(r'<[^>]+>', '', h).strip() for h in headlines[:4]]

            # 2. CTAs (botones de compra)
            ctas = re.findall(r'(?:value|aria-label|class)[^>]*(?:cart|comprar|añadir|buy|checkout)[^>]*>([^<]{3,40})<', html, re.IGNORECASE)
            ctas += re.findall(r'<button[^>]*>([^<]{3,40})</button>', html)
            ctas = list(set([c.strip() for c in ctas if len(c.strip()) > 2]))[:5]

            # 3. Precio
            prices = re.findall(r'(?:€|EUR)\s*(\d+[,.]?\d*)', html)[:3]

            # 4. Badges de confianza
            trust = re.findall(r'(?:garantía|devolución|envío gratis|pago seguro|días|24h|48h)[^<]{0,60}', html, re.IGNORECASE)[:4]

            # 5. Título de la página
            title_m = re.search(r'<title>([^<]{5,100})</title>', html)
            page_title = title_m.group(1).strip() if title_m else ""

            domain = urllib.parse.urlparse(url).netloc
            insight = f"**{domain}**\n"
            if page_title:   insight += f"- Título: {page_title[:80]}\n"
            if headlines:    insight += f"- Headlines: {' | '.join(headlines[:2])}\n"
            if prices:       insight += f"- Precio: €{prices[0]}\n"
            if ctas:         insight += f"- CTAs: {', '.join(ctas[:3])}\n"
            if trust:        insight += f"- Confianza: {' | '.join(trust[:2])}\n"

            insights.append(insight)
            print(f"  ✅ Scrapeado: {domain}", flush=True)

        except Exception as e:
            print(f"  ⚠️  Scraping {url[:40]}: {e}", flush=True)

    if not insights:
        return ""

    return "\n\nCOMPETIDORES REALES ANALIZADOS:\n" + "\n".join(insights)


def extract_top_product(raw: str) -> dict:
    """Extrae el mejor producto del output del Lead Qualifier."""
    candidates = []

    # 1. Buscar en bloques ```json
    if "```json" in raw:
        for block in reversed(raw.split("```json")[1:]):
            candidates.append(block.split("```")[0].strip())

    # 2. Si empieza con { (JSON crudo sin markdown)
    stripped = raw.strip()
    if stripped.startswith("{"):
        candidates.append(stripped)

    # 3. Buscar primer { ... } que contenga "qualified" o "top_pick"
    import re as _re
    for m in _re.finditer(r'\{[\s\S]*?"(?:qualified|top_pick)"[\s\S]*?\}(?=\s*$|\s*```)', raw):
        candidates.append(m.group(0))

    for candidate in candidates:
        try:
            data = json.loads(candidate)
            if data.get("top_pick"):       return data["top_pick"]
            if data.get("qualified"):      return data["qualified"][0]
            if data.get("name"):           return data  # ya es un producto directo
        except Exception:
            continue

    return {"name": raw[:100]}


def upload_preview(html: str, api_url: str, secret: str) -> str:
    """Sube el HTML al servidor Railway y devuelve la URL de preview."""
    url = f"{api_url.rstrip('/')}/preview"
    data = html.encode("utf-8")
    req  = urllib.request.Request(
        url, data=data,
        headers={
            "Content-Type":  "text/html; charset=utf-8",
            "Authorization": f"Bearer {secret}",
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            result = json.loads(r.read().decode("utf-8"))
            return result.get("url", "")
    except Exception as e:
        print(f"  ⚠️  Preview upload error: {e}", flush=True)
        return ""


def main():
    api_key    = os.environ.get("OPENROUTER_API_KEY", "").strip()
    pexels_key = os.environ.get("PEXELS_API_KEY", "").strip()
    # Usar PUBLIC_URL para el preview (no localhost)
    api_url    = (os.environ.get("PUBLIC_URL") or
                  os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100")).rstrip("/")
    # Si sigue siendo localhost, usar la URL pública conocida
    if "localhost" in api_url or "127.0.0.1" in api_url:
        api_url = "https://spirited-charm-production.up.railway.app"
    jwt_secret = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or
                  os.environ.get("BETTER_AUTH_SECRET", "")).strip()

    if not api_key:
        post_issue_result("❌ Web Designer: OPENROUTER_API_KEY no configurada.")
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw     = issue_body if issue_body else (issue_title or "")
    print(f"  📥 Raw input ({len(raw)} chars): {raw[:300]}...", flush=True)
    print(f"  📥 Starts with {{: {raw.strip().startswith('{')}", flush=True)
    print(f"  📥 Has ```json: {'```json' in raw}", flush=True)

    product = extract_top_product(raw)
    print(f"  📥 Product extracted: name='{product.get('name','?')[:60]}' score={product.get('score','?')}", flush=True)
    name    = product.get("name", "")

    # Si no hay JSON pero hay markdown del qualifier, extraer del texto
    if (not name or name == raw[:100]) and "LAUNCH" in raw or "Score:" in raw:
        import re as _re2
        # Buscar nombre del primer producto LAUNCH o TEST en el markdown
        m_name = _re2.search(r'###\s*🟢.*?(?:LAUNCH.*?)?\s*([\w][\w\s\(\)/áéíóúüñÁÉÍÓÚÜÑ,\-\.]+?)\s*—\s*Score:', raw)
        if not m_name:
            m_name = _re2.search(r'###\s*🟡.*?\s*([\w][\w\s\(\)/áéíóúüñÁÉÍÓÚÜÑ,\-\.]+?)\s*—\s*Score:', raw)
        if m_name:
            name = m_name.group(1).strip()
            # Extraer score
            m_score = _re2.search(r'Score:\s*\*\*(\d+)/100\*\*', raw)
            if m_score:
                product["score"] = int(m_score.group(1))
            # Extraer fortaleza
            m_str = _re2.search(r'\*\*Fortaleza:\*\*\s*([^\n]+)', raw)
            if m_str:
                product["key_strength"] = m_str.group(1).strip()
            # Extraer hook
            m_hook = _re2.search(r'\*\*Hook:\*\*\s*["\*]*([^\n"*]+)', raw)
            if m_hook:
                product["suggested_hook"] = m_hook.group(1).strip()
            # Extraer revenue
            m_rev = _re2.search(r'€([\d,\.]+)', raw)
            if m_rev:
                product["suggested_price_eur"] = m_rev.group(1).replace(",", "")
            product["name"] = name
            print(f"  📥 Producto extraído del markdown: {name}", flush=True)

    # Si no hay datos del producto, generarlos con LLM a partir del nicho
    if not name or name == raw[:100]:
        print("  ⚠️  Sin datos de producto — generando con LLM desde nicho...", flush=True)
        niche_hint = issue_title or raw[:100] or "producto de dropshipping"
        try:
            gen = call_llm(
                messages=[{"role": "user", "content": f"""Para el nicho "{niche_hint}", genera un producto ganador de dropshipping en España.
Responde SOLO con JSON:
{{"name":"nombre exacto","score":78,"suggested_price_eur":29.90,"est_margin_pct":65,"key_strength":"ventaja principal","main_risk":"objeción principal","suggested_hook":"hook en español max 8 palabras","target_audience":"descripción audiencia"}}"""}],
                api_key=api_key, max_tokens=300, temperature=0.5,
                title="Web Designer - product gen", model="anthropic/claude-3-5-haiku", timeout=15,
            )
            clean = gen.strip()
            if "```" in clean: clean = clean.split("```")[1].split("```")[0].strip()
            product = json.loads(clean)
            name = product.get("name", niche_hint)
            print(f"  ✅ Producto generado: {name}", flush=True)
        except Exception as e:
            print(f"  ⚠️  Product gen error: {e}", flush=True)
            name = niche_hint

    score    = product.get("score", "?")
    price    = product.get("suggested_price_eur", "?")
    margin   = product.get("est_margin_pct", "?")
    hook     = product.get("suggested_hook", "")
    strength = product.get("key_strength", "")
    risk     = product.get("main_risk", "")
    audience = product.get("target_audience", "adultos 25-45")

    post_issue_comment(
        f"🎨 Web Designer cargando skills + analizando competidores para: **{name}**\n\n"
        f"Paso 0: Skills + Competidores → Paso 1: Estructura copy → Paso 2: HTML preview"
    )

    # ── Cargar referencia de landings ─────────────────────────────────────────
    print("📖 Cargando referencia de landings...", flush=True)
    reference_context = load_reference_landings()

    # ── Fetch skills desde Paperclip ──────────────────────────────────────────
    print("📚 Cargando skills desde Paperclip...", flush=True)
    skill_lp  = fetch_skill("landing-page-copywriter", company_id=DROPS_COMPANY)
    skill_wd  = fetch_skill("web-designer",            company_id=DROPS_COMPANY)

    skill_context = ""
    if skill_lp:
        # Extraer sección de frameworks (después del frontmatter)
        lp_content = skill_lp
        if "## Instructions" in lp_content:
            lp_content = lp_content.split("## Instructions")[1][:2500]
        skill_context += f"\n\n--- LANDING PAGE FRAMEWORKS (skill) ---\n{lp_content}"
    if skill_wd:
        wd_content = skill_wd
        if "---" in wd_content:
            parts = wd_content.split("---")
            wd_content = "---".join(parts[2:])[:1500] if len(parts) > 2 else wd_content[:1500]
        skill_context += f"\n\n--- WEB DESIGNER GUIDELINES (skill) ---\n{wd_content}"

    print(f"  ✅ Skill context: {len(skill_context)} chars", flush=True)

    # ── PASO 0a: Imágenes (CJ real → Pexels → Unsplash fallback) ────────────
    print(f"\n🖼️  Buscando imágenes para: {name}", flush=True)

    # Prioridad 1: imagen real del proveedor CJ para el HERO
    # + Openverse para el grid de producto (variedad visual)
    cj_image = product.get("image_url", "")
    images = {}

    if cj_image and cj_image.startswith("http"):
        print(f"  ✅ Imagen real producto (hero): {cj_image[:60]}", flush=True)
        # Imágenes extra de Serper para el grid (si las hay)
        extra = [u for u in product.get("extra_image_urls", []) if u.startswith("http")]
        images = {
            "hero":    [cj_image],
            "product": extra[:3] if extra else [],
            "context": extra[3:5] if len(extra) > 3 else [],
            "all":     [cj_image] + extra[:4],
        }
        print(f"  🖼️  Grid: {len(extra[:3])} imágenes adicionales", flush=True)
    # Prioridad 2: Pexels API
    elif pexels_key:
        images = fetch_pexels_images(name, pexels_key)

    # Prioridad 3: Openverse solo si no hay imagen CJ
    if not images.get("all"):
        print(f"  ℹ️  Sin imagen CJ — usando Openverse", flush=True)
        search_context = f"{name} {issue_title}".strip()
        images = fetch_openverse_images(search_context)
    hero_imgs    = images.get("hero", []) if images else []
    hero_img     = hero_imgs[0] if hero_imgs else ""
    product_imgs = images.get("product", []) if images else []
    context_imgs = images.get("context", []) if images else []

    # Construir bloque de imagen para inyectar en el HTML
    img_block = ""
    if hero_img:
        img_block += f'\n<!-- HERO IMAGE -->\n<img src="{hero_img}" alt="{name}" class="hero-img">\n'
    for i, url in enumerate(product_imgs[:3]):
        img_block += f'\n<!-- PRODUCT IMAGE {i+1} -->\n<img src="{url}" alt="{name} imagen {i+1}" class="product-img">\n'

    images_context = ""
    if images.get("all"):
        images_context = "\n\nIMÁGENES DISPONIBLES (úsalas en el HTML):\n"
        all_imgs = images.get("all", [])
        if all_imgs:
            images_context += f"- Hero/Banner: {all_imgs[0]}\n"
        for i, url in enumerate(all_imgs[1:4], 2):
            images_context += f"- Producto {i-1}: {url}\n"
        for i, url in enumerate(all_imgs[4:], 5):
            images_context += f"- Contexto {i-4}: {url}\n"

    # ── PASO 0b: Scraping de competidores ────────────────────────────────────
    print(f"\n🔍 Buscando competidores para: {name}", flush=True)
    competitor_context = scrape_competitor_landings(name, max_pages=3)
    if competitor_context:
        print(f"  ✅ Contexto de competidores: {len(competitor_context)} chars", flush=True)
    else:
        print(f"  ⚠️  Sin datos de competidores — generando desde cero", flush=True)

    # ── PASO 1: Generar estructura de copy ────────────────────────────────────
    structure_prompt = f"""Genera la estructura completa de copy para una landing page Shopify:

Producto: {name}
Score: {score}/100 | Precio: €{price} | Margen: {margin}%
Audiencia: {audience}
Fortaleza: {strength}
Riesgo a superar: {risk}
Hook: {hook}
{competitor_context}
{skill_context}

--- REFERENCIA DE LANDINGS DE ALTA CONVERSIÓN ($4M-$150M revenue) ---
{reference_context[:3000]}

INSTRUCCIONES:
- Si hay datos de competidores, analiza qué está funcionando (precios, CTAs, headlines)
- Replica la estructura que ya convierte y mejora el copy
- Si no hay competidores, usa los frameworks PAS/AIDA

Genera estas secciones con copy real en español:
1. HERO — headline (máx 8 palabras), subheadline, CTA text, 3 badges de confianza
2. PROBLEMA — 2 párrafos empáticos
3. BENEFICIOS — 6 puntos con emoji + título + descripción
4. RESEÑAS — 3 reseñas con nombre español, ciudad, profesión, 5 estrellas
5. GARANTÍA — texto de garantía 30 días
6. FAQ — 4 preguntas frecuentes con respuestas
7. CTA FINAL — urgencia + precio tachado + precio actual"""

    try:
        structure = call_llm(
            messages=[
                {"role": "system", "content": STRUCTURE_SYSTEM},
                {"role": "user", "content": structure_prompt}
            ],
            api_key=api_key, max_tokens=2500, temperature=0.6,
            title="DiscontrolDrops - Web Designer (structure)",
            model="anthropic/claude-sonnet-4-5", timeout=40, retries=1,
        )
    except Exception as e:
        post_issue_result(f"❌ Web Designer error generando estructura: {e}")
        sys.exit(1)

    # ── PASO 2: Generar HTML visual ───────────────────────────────────────────
    html_prompt = f"""Crea una landing page HTML completa y visual para este producto:

PRODUCTO: {name}
PRECIO: €{price}
HOOK: {hook}
{images_context}
COPY GENERADO:
{structure[:2500]}

REGLAS DE IMÁGENES:
{"- Hero: usa la imagen real del producto como fondo del hero (background-image con overlay oscuro semitransparente). NUNCA uses otras URLs que no sean las proporcionadas." if images.get("hero") else "- Sin imagen de producto disponible — usa un hero con gradiente CSS oscuro profesional, sin img tags"}
{"- Grid de producto: NO uses imágenes adicionales. En su lugar usa CARDS CSS con iconos emoji grandes (2-3 cards) destacando las características principales del producto. Ejemplo: card con emoji 📱, título y descripción." if not images.get("product") else "- Grid: usa las imágenes del producto proporcionadas"}
- NO inventes URLs de imágenes ni uses placeholders como via.placeholder.com
- NO pongas img tags sin URL real — mejor sin imagen que con imagen rota

Genera HTML completo con:
- <head> con meta tags, Google Fonts (Inter o Poppins)
- <style> con CSS moderno mobile-first
  * Fondo blanco limpio o #0f0f0f oscuro según el producto
  * CTA naranja #f97316 o verde #22c55e
  * Tipografía clara, jerarquía visual fuerte
  * Hero con imagen de fondo real (background-image o <img> con overlay)
  * Secciones con padding generoso, máx-width 1200px centrado
- Secciones: hero con imagen, beneficios con iconos, imágenes del producto, reseñas, garantía, FAQ, CTA final
- Botón CTA grande prominente (repetido 3+ veces)
- Footer con badges de pago seguro (Visa, Mastercard, PayPal, SSL)
- Responsive: 1 columna en móvil, 2-3 en desktop

Devuelve SOLO el HTML completo, sin explicaciones ni markdown."""

    try:
        html_content = call_llm(
            messages=[
                {"role": "system", "content": HTML_SYSTEM},
                {"role": "user", "content": html_prompt}
            ],
            api_key=api_key, max_tokens=8000, temperature=0.5,
            title="DiscontrolDrops - Web Designer (HTML)",
            model="anthropic/claude-sonnet-4-5", timeout=60, retries=1,
        )
        # Limpiar markdown si el LLM añadió ```html
        if "```html" in html_content:
            html_content = html_content.split("```html")[1].split("```")[0].strip()
        elif "```" in html_content:
            html_content = html_content.split("```")[1].split("```")[0].strip()

    except Exception as e:
        html_content = ""
        print(f"  ⚠️  HTML generation error: {e}", flush=True)

    # ── PASO 3: Subir preview a Railway ──────────────────────────────────────
    preview_url = ""
    if html_content and jwt_secret:
        secret16 = jwt_secret[:16]
        preview_url = upload_preview(html_content, api_url, secret16)
        if preview_url:
            print(f"  ✅ Preview disponible: {preview_url}", flush=True)

    # ── Output final ──────────────────────────────────────────────────────────
    preview_section = ""
    if preview_url:
        preview_section = (
            f"\n\n## 🌐 PREVIEW VISUAL\n"
            f"**[Ver landing page en vivo → {preview_url}]({preview_url})**\n\n"
            f"> Abre el link, revisa el diseño, edita lo que necesites.\n"
            f"> Cuando estés listo, publica en Shopify.\n"
        )
    else:
        preview_section = "\n\n> ⚠️ Preview no disponible — revisa PAPERCLIP_API_URL y BETTER_AUTH_SECRET\n"

    output = f"# 🎨 LANDING SHOPIFY — {name}\n{preview_section}\n## 📝 Estructura de copy\n\n{structure}"
    print(output[:500], flush=True)
    post_issue_result(output)


if __name__ == "__main__":
    main()
