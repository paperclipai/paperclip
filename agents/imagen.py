"""
Agente: Imagen Generator
Genera imágenes con Higgsfield Soul (text-to-image).

Docs: https://docs.higgsfield.ai
Auth (nuevo endpoint): hf-api-key: <uuid>  +  hf-secret: <secret>
      HIGGSFIELD_API_KEY debe tener formato "uuid:secret"
Submit:  POST https://platform.higgsfield.ai/v1/text2image/soul
         Body: { "params": { "prompt", "width_and_height", "batch_size",
                              "quality", "soul_style", "style_strength", ... } }
Fallback:POST https://platform.higgsfield.ai/soul  (legacy, sin params anidado)
Poll:    GET  https://platform.higgsfield.ai/requests/{id}/status
Styles:  GET  https://platform.higgsfield.ai/v1/text2image/soul-styles

Nota: el campo de estilo es "soul_style" (nombre de texto, no UUID).
"""
import os
import sys
import json
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BASE_URL = "https://platform.higgsfield.ai"

DONE_STATUSES    = {"completed", "failed", "nsfw"}
SUCCESS_STATUSES = {"completed"}

# Mapa aspect_ratio → width_and_height (formato que acepta el API v1)
ASPECT_TO_WH = {
    "9:16":  "1152x2048",   # vertical TikTok/Reels — predeterminado
    "16:9":  "2048x1152",   # horizontal
    "4:3":   "2048x1536",
    "3:4":   "1536x2048",
    "1:1":   "1152x2048",   # cuadrado no disponible → usar vertical
}
DEFAULT_WH = "1152x2048"

BROWSER_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":          "application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://cloud.higgsfield.ai",
    "Referer":         "https://cloud.higgsfield.ai/",
}


def parse_api_key(api_key: str) -> tuple:
    """Divide 'uuid:secret' en (hf_key, hf_secret). Si no hay ':', devuelve ('', api_key)."""
    if ":" in api_key:
        idx = api_key.index(":")
        return api_key[:idx].strip(), api_key[idx+1:].strip()
    return "", api_key.strip()


def make_headers_v1(hf_key: str, hf_secret: str) -> dict:
    return {
        **BROWSER_HEADERS,
        "hf-api-key":    hf_key,
        "hf-secret":     hf_secret,
        "Content-Type":  "application/json",
    }


def make_headers_legacy(api_key: str) -> dict:
    return {
        **BROWSER_HEADERS,
        "Authorization": f"Key {api_key}",
        "Content-Type":  "application/json",
    }


def http_post(url: str, payload: dict, headers: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        raise Exception(f"HTTP {e.code} — {body[:500]}")


def http_get(url: str, headers: dict) -> dict:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        raise Exception(f"HTTP {e.code} — {body[:500]}")


def fetch_soul_styles(api_key: str) -> list:
    """Obtiene la lista de estilos disponibles en Soul. Devuelve [] si falla."""
    hf_key, hf_secret = parse_api_key(api_key)
    url = f"{BASE_URL}/v1/text2image/soul-styles"
    try:
        data = http_get(url, make_headers_v1(hf_key, hf_secret))
        styles = data if isinstance(data, list) else (data.get("styles") or data.get("data") or [])
        print(f"  ✅ {len(styles)} estilos Soul disponibles", flush=True)
        return styles
    except Exception as e:
        print(f"  ⚠️  No se pudo obtener estilos Soul: {e}", flush=True)
        return []


def submit_image(prompt: str, aspect_ratio: str, api_key: str,
                 soul_style: str = None, style_strength: float = 1.0) -> str:
    """
    Envía solicitud a Higgsfield Soul.
    Prueba el endpoint nuevo v1 primero; si falla, usa el legacy.
    soul_style: nombre de texto del estilo (ej. "Cinematic", "Anime", None = sin estilo).
    Devuelve request_id.
    """
    hf_key, hf_secret = parse_api_key(api_key)
    width_and_height   = ASPECT_TO_WH.get(aspect_ratio, DEFAULT_WH)

    print(f"  📐 Formato: {width_and_height}  Estilo: {soul_style or 'base'}", flush=True)

    attempts = []

    # ── Intento 1: endpoint nuevo /v1/text2image/soul ──
    if hf_key and hf_secret:
        params_v1 = {
            "prompt":           prompt,
            "width_and_height": width_and_height,
            "batch_size":       1,
            "quality":          "720p",
            "style_strength":   style_strength,
            "enhance_prompt":   False,
        }
        if soul_style:
            params_v1["soul_style"] = soul_style
        payload_v1 = {"params": params_v1}
        attempts.append((
            f"{BASE_URL}/v1/text2image/soul",
            payload_v1,
            make_headers_v1(hf_key, hf_secret),
            "v1",
        ))

    # ── Intento 2: endpoint legacy /soul ──
    payload_legacy = {
        "prompt":           prompt,
        "width_and_height": width_and_height,
        "batch_size":       1,
        "quality":          "720p",
        "style_strength":   style_strength,
        "enhance_prompt":   False,
    }
    if soul_style:
        payload_legacy["soul_style"] = soul_style
    attempts.append((
        f"{BASE_URL}/soul",
        payload_legacy,
        make_headers_legacy(api_key),
        "legacy",
    ))

    last_err = None
    for url, payload, headers, tag in attempts:
        print(f"  📡 POST {url}  [{tag}]", flush=True)
        try:
            result     = http_post(url, payload, headers)
            request_id = result.get("request_id")
            if request_id:
                print(f"  📤 En cola → ID: {request_id}  [{tag}]", flush=True)
                return request_id
            print(f"  ⚠️  Sin request_id [{tag}]. Respuesta: {json.dumps(result)[:200]}", flush=True)
        except Exception as e:
            last_err = e
            print(f"  ⚠️  {tag} falló: {e}", flush=True)

    raise Exception(f"Todos los endpoints Soul fallaron — último error: {last_err}")


def poll_result(request_id: str, api_key: str, max_wait: int = 180) -> str:
    """Hace polling hasta obtener la URL de la imagen. Timeout 3 min."""
    hf_key, hf_secret = parse_api_key(api_key)
    headers   = make_headers_v1(hf_key, hf_secret) if hf_key else make_headers_legacy(api_key)
    deadline  = time.time() + max_wait
    interval  = 5
    status_url = f"{BASE_URL}/requests/{request_id}/status"

    while time.time() < deadline:
        data   = http_get(status_url, headers)
        status = (data.get("status") or "unknown").lower()
        print(f"  ⏳ Estado: {status}", flush=True)

        if status in SUCCESS_STATUSES:
            # La imagen puede venir en distintos formatos según el endpoint
            images = data.get("images") or []
            if images and images[0].get("url"):
                return images[0]["url"]
            # Formato alternativo: image.url (singular)
            img = data.get("image") or {}
            if img.get("url"):
                return img["url"]
            # Otro posible campo
            if data.get("image_url"):
                return data["image_url"]
            raise Exception(f"completed pero sin URL de imagen: {json.dumps(data)[:300]}")

        if status == "nsfw":
            raise Exception("Imagen rechazada por moderación (NSFW). Intenta con otro prompt.")
        if status == "failed":
            raise Exception(f"Generación fallida: {data.get('error', '')}")

        time.sleep(interval)

    raise Exception(f"Timeout ({max_wait}s) esperando resultado de {request_id}")


def generate_image(prompt: str, aspect_ratio: str, label: str, api_key: str,
                   soul_style: str = None, style_strength: float = 1.0,
                   max_retries: int = 2) -> dict:
    """Genera imagen con reintentos automáticos ante fallos de API o timeout."""
    print(f"\n🎨 Generando {label} ({aspect_ratio}) con Higgsfield Soul...", flush=True)
    last_error = None
    for attempt in range(1, max_retries + 2):
        if attempt > 1:
            wait = 15 * (attempt - 1)
            print(f"  🔄 Reintento {attempt}/{max_retries + 1} en {wait}s...", flush=True)
            time.sleep(wait)
        try:
            request_id = submit_image(prompt, aspect_ratio, api_key, soul_style, style_strength)
            url        = poll_result(request_id, api_key)
            print(f"  ✅ {label} lista → {url}", flush=True)
            return {
                "label":          label,
                "aspect_ratio":   aspect_ratio,
                "prompt":         prompt,
                "url":            url,
                "soul_style":     soul_style,
                "style_strength": style_strength,
                "status":         "ok",
            }
        except Exception as e:
            last_error = e
            print(f"  ⚠️  Intento {attempt} fallido: {e}", flush=True)

    print(f"  ❌ {label} falló tras {max_retries + 1} intentos", flush=True)
    return {
        "label":        label,
        "aspect_ratio": aspect_ratio,
        "prompt":       prompt,
        "url":          None,
        "status":       f"error: {last_error}",
    }


def extract_prompts(input_text: str) -> tuple:
    """
    Extrae scene_prompts[] del JSON del prompt_generator, o usa fallback.
    Devuelve (prompts_list, soul_style, style_strength).
    soul_style es el nombre de texto del estilo Soul (ej. "Cinematic"), no un UUID.
    """
    import re as _re
    json_str      = None
    soul_style    = None
    style_strength = 1.0

    if "```json" in input_text:
        json_str = input_text.split("```json")[1].split("```")[0].strip()
    elif "```" in input_text:
        json_str = input_text.split("```")[1].split("```")[0].strip()
    elif input_text.strip().startswith("{"):
        json_str = input_text.strip()
    else:
        m = _re.search(r'\{[\s\S]*?"scene_prompts"[\s\S]*?\}(?:\s*$|\n)', input_text)
        if not m:
            m = _re.search(r'(\{[\s\S]*\})', input_text)
        if m:
            json_str = m.group(0).strip()

    if json_str:
        try:
            data   = json.loads(json_str)
            scenes = data.get("scene_prompts", [])

            # Leer estilo del JSON si viene del director / Studio
            # Campo preferido: soul_style (nombre texto). Fallbacks para compatibilidad.
            soul_style     = data.get("soul_style") or data.get("soul_style_id") or data.get("style_id")
            style_strength = float(data.get("soul_style_strength", data.get("style_strength", 1.0)))

            if scenes:
                prompts = []
                for s in scenes:
                    prompts.append({
                        "prompt":       s["prompt"],
                        "aspect_ratio": s.get("aspect_ratio", "9:16"),
                        "label":        f"Escena {s['scene']}: {s.get('title', '')}",
                    })
                print(f"  ✅ {len(prompts)} escenas extraídas  estilo={soul_style or 'base'}", flush=True)
                return prompts, soul_style, style_strength

            # Input de Studio: {"soul_style": "X", "prompt": "texto del tema"}
            raw_prompt = data.get("prompt", "").strip()
            if raw_prompt:
                aspect = data.get("aspect_ratio", "9:16")
                prompts = [{
                    "prompt": (
                        f"Cinematic vertical TikTok scene: {raw_prompt}. "
                        "Dramatic lighting, photorealistic, ultra-detailed, 9:16 format, "
                        "emotional storytelling visual, shot on Sony A7 III."
                    ),
                    "aspect_ratio": aspect,
                    "label": "Escena 1: Thumbnail principal",
                }]
                print(f"  ✅ Prompt de Studio extraído  estilo={soul_style or 'base'}", flush=True)
                return prompts, soul_style, style_strength

        except (json.JSONDecodeError, KeyError) as e:
            print(f"  ⚠️  No se pudo parsear JSON: {e} — usando fallback", flush=True)

    # Leer estilo de variable de entorno (para tests manuales)
    soul_style     = soul_style or os.environ.get("SOUL_STYLE", "").strip() or None
    style_strength = style_strength or float(os.environ.get("SOUL_STYLE_STRENGTH", "1.0"))

    print("  ℹ️  Usando prompt de fallback (sin JSON válido en el input)", flush=True)
    lines   = [l.strip() for l in input_text.split("\n") if l.strip()]
    concept = " ".join(lines[:5])[:300]
    prompts = [{
        "prompt": (
            f"Cinematic vertical TikTok thumbnail for: {concept}. "
            "Epic action scene, dramatic lighting, cinematic photography. "
            "Close-up portrait with intense expression, moody atmosphere, "
            "hyperrealistic, 8K quality, shot on Sony A7 III, 35mm lens, f/1.8."
        ),
        "aspect_ratio": "9:16",
        "label": "Escena 1: Thumbnail",
    }]
    return prompts, soul_style, style_strength


def main():
    api_key = os.environ.get("HIGGSFIELD_API_KEY", "").strip()
    if not api_key:
        print("ERROR: HIGGSFIELD_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) > 1:
        script_input = " ".join(sys.argv[1:])
    else:
        script_input = sys.stdin.read().strip()

    issue_title, issue_body = resolve_issue_context()
    if issue_title:
        script_input = issue_body if issue_body else issue_title
        post_issue_comment(
            f"🖼️ Recibido. Voy a generar las imágenes para: **{issue_title}**\n\n"
            f"Mando las escenas a Higgsfield Soul ahora mismo — las proceso en paralelo "
            f"para que no tengas que esperar. Puede tardar 2-3 minutos."
        )

    if not script_input:
        script_input = "Genera imágenes cinematográficas para contenido viral en TikTok y YouTube"

    print("🖼️  IMAGEN GENERATOR INICIANDO", flush=True)
    print(f"📌 Input: {script_input[:100]}…", flush=True)

    prompts, soul_style, style_strength = extract_prompts(script_input)
    results = [None] * len(prompts)

    if soul_style:
        print(f"🎨 Estilo Soul: {soul_style}  fuerza={style_strength}", flush=True)

    print(f"\n🚀 Generando {len(prompts)} imágenes en paralelo...", flush=True)

    def run(idx, item):
        return idx, generate_image(
            prompt         = item["prompt"],
            aspect_ratio   = item["aspect_ratio"],
            label          = item["label"],
            api_key        = api_key,
            soul_style     = soul_style,
            style_strength = style_strength,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(run, i, item): i for i, item in enumerate(prompts)}
        for future in as_completed(futures):
            idx, result = future.result()
            results[idx] = result
            status = "✅" if result["status"] == "ok" else "❌"
            print(f"  {status} {result['label']} completada", flush=True)

    # Output estructurado
    ok_count = sum(1 for r in results if r and r["status"] == "ok")
    lines = [f"# 🖼️ IMÁGENES GENERADAS — Higgsfield Soul\n"]
    lines.append(f"**{ok_count}/{len(results)} imágenes generadas correctamente**")
    if soul_style:
        lines.append(f"**Estilo:** `{soul_style}` · fuerza `{style_strength}`\n")
    else:
        lines.append("")

    for r in results:
        icon = "✅" if r["status"] == "ok" else "❌"
        lines.append(f"## {icon} {r['label']} ({r['aspect_ratio']})")
        if r["url"]:
            lines.append(f"**URL:** {r['url']}")
            lines.append(f"![{r['label']}]({r['url']})")
        else:
            lines.append(f"**Error:** {r['status']}")
        lines.append(f"**Prompt:** {r['prompt'][:150]}…")
        lines.append("")

    lines.append("```json")
    lines.append(json.dumps(results, indent=2, ensure_ascii=False))
    lines.append("```")

    output = "\n".join(lines)
    print(output, flush=True)
    post_issue_result(output)


if __name__ == "__main__":
    main()
