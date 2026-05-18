"""
Agente: Popcorn Auto (Higgsfield)
Genera hasta 8 imágenes visualmente coherentes de una sola llamada
a partir de un prompt narrativo. Ideal para crear sets de escenas
con estética consistente para el pipeline de video.

Docs: https://docs.higgsfield.ai
Auth: Authorization: Key {KEY_ID}:{KEY_SECRET}  (auth genérica de plataforma)
Submit: POST https://platform.higgsfield.ai/higgsfield-ai/popcorn/auto
Poll:   GET  https://platform.higgsfield.ai/requests/{id}/status
Result: images[].url cuando status == "completed"

Input (JSON del storytelling/prompt_generator o texto libre):
{
  "prompt":       "Un periodista descubre...",   // narrativa completa
  "num_images":   5,                             // 1-8, default 5
  "aspect_ratio": "9:16",                        // default 9:16
  "resolution":   "720p",                        // "720p" | "1600p"
  "image_urls":   []                             // referencias visuales opcionales
}

Output: texto con URLs de las imágenes generadas + JSON estructurado.
"""
import os
import sys
import json
import time
import urllib.request
import urllib.error
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BASE_URL   = "https://platform.higgsfield.ai"
ENDPOINT   = "higgsfield-ai/popcorn/auto"

DONE_STATUSES    = {"completed", "failed", "nsfw", "canceled"}
SUCCESS_STATUSES = {"completed"}

BROWSER_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":          "application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://cloud.higgsfield.ai",
    "Referer":         "https://cloud.higgsfield.ai/",
}


def make_headers(api_key: str) -> dict:
    return {
        **BROWSER_HEADERS,
        "Authorization": f"Key {api_key}",
        "Content-Type":  "application/json",
    }


def http_post(url: str, payload: dict, api_key: str) -> dict:
    data    = json.dumps(payload).encode("utf-8")
    headers = make_headers(api_key)
    req     = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        raise Exception(f"HTTP {e.code} — {body[:500]}")


def http_get(url: str, api_key: str) -> dict:
    req = urllib.request.Request(url, headers=make_headers(api_key), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        raise Exception(f"HTTP {e.code} — {body[:500]}")


def submit_popcorn(prompt: str, num_images: int, aspect_ratio: str,
                   resolution: str, image_urls: list, api_key: str) -> str:
    """Envía la petición a Popcorn Auto. Devuelve request_id."""
    url = f"{BASE_URL}/{ENDPOINT}"
    payload = {
        "prompt":       prompt,
        "aspect_ratio": aspect_ratio,
        "num_images":   num_images,
        "resolution":   resolution,
    }
    if image_urls:
        payload["image_urls"] = image_urls
    print(f"  📡 POST {url}", flush=True)
    print(f"  📝 num_images={num_images}  ratio={aspect_ratio}  res={resolution}", flush=True)
    result = http_post(url, payload, api_key)
    request_id = result.get("request_id")
    if not request_id:
        raise Exception(f"Sin request_id en respuesta: {json.dumps(result)[:300]}")
    print(f"  📤 En cola → ID: {request_id}", flush=True)
    return request_id


def poll_images(request_id: str, api_key: str, max_wait: int = 360) -> list:
    """
    Polling hasta obtener las URLs de las imágenes.
    Popcorn puede tardar más que Soul dependiendo del num_images.
    Timeout 6 min (cola de Higgsfield puede ser larga).
    Lanza ServerFailedError en vez de Exception genérica para distinguir
    errores de servidor (reintentables) de errores de contenido.
    """
    deadline   = time.time() + max_wait
    interval   = 8
    status_url = f"{BASE_URL}/requests/{request_id}/status"

    # Dar tiempo a Higgsfield para encolar el job antes del primer check
    time.sleep(10)

    while time.time() < deadline:
        data   = http_get(status_url, api_key)
        status = (data.get("status") or "unknown").lower()
        print(f"  ⏳ {request_id[:12]}… → {status}", flush=True)

        if status in SUCCESS_STATUSES:
            # Extraer URLs de imágenes — varios formatos posibles
            images = data.get("images") or []
            urls   = [img["url"] for img in images if img.get("url")]
            if not urls:
                # Alternativa: lista plana de URLs
                urls = data.get("image_urls") or data.get("output", {}).get("images") or []
            if urls:
                return urls
            raise Exception(f"completed pero sin imágenes: {json.dumps(data)[:300]}")

        if status == "nsfw":
            raise Exception("NSFW: Imágenes rechazadas por moderación.")
        if status == "canceled":
            raise Exception("Generación cancelada.")
        if status == "failed":
            # Error de servidor — lanzar tipo especial para activar retry en main()
            raise _ServerFailedError(f"Higgsfield server failed: {data.get('error', 'Generation failed')}")

        time.sleep(interval)

    raise Exception(f"Timeout ({max_wait}s) esperando imágenes de {request_id}")


class _ServerFailedError(Exception):
    """Error de servidor de Higgsfield — reintentable."""
    pass


def extract_params(raw: str) -> dict:
    """
    Extrae parámetros del input (JSON o texto libre).
    Devuelve dict con: prompt, num_images, aspect_ratio, resolution, image_urls.
    """
    # Intentar parsear JSON
    json_str = None
    if "```json" in raw:
        json_str = raw.split("```json")[1].split("```")[0].strip()
    elif "```" in raw:
        json_str = raw.split("```")[1].split("```")[0].strip()
    elif raw.strip().startswith("{"):
        json_str = raw.strip()
    else:
        m = re.search(r'\{[\s\S]*?"prompt"[\s\S]*?\}', raw)
        if m:
            json_str = m.group(0)

    if json_str:
        try:
            data = json.loads(json_str)
            return {
                "prompt":       data.get("prompt", raw.strip()[:1000]),
                "num_images":   min(8, max(1, int(data.get("num_images", 5)))),
                "aspect_ratio": data.get("aspect_ratio", "9:16"),
                "resolution":   data.get("resolution", "720p"),
                "image_urls":   data.get("image_urls", []),
            }
        except Exception as e:
            print(f"  ⚠️  JSON parse error: {e} — usando texto libre como prompt", flush=True)

    # Fallback: usar el texto completo como prompt
    return {
        "prompt":       raw.strip()[:1500],
        "num_images":   5,
        "aspect_ratio": "9:16",
        "resolution":   "720p",
        "image_urls":   [],
    }


def main():
    api_key = os.environ.get("HIGGSFIELD_API_KEY", "").strip()
    if not api_key:
        print("ERROR: HIGGSFIELD_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    else:
        raw = sys.stdin.read().strip()

    issue_title, issue_body = resolve_issue_context()
    if issue_title:
        raw = issue_body if issue_body else raw
        post_issue_comment(
            f"🍿 Generando set de imágenes coherentes con Higgsfield Popcorn para: **{issue_title}**\n\n"
            f"Popcorn crea varias imágenes con estética visual consistente de una sola llamada. "
            f"Puede tardar 2-4 minutos."
        )

    if not raw:
        print("ERROR: Sin input", file=sys.stderr)
        sys.exit(1)

    print("🍿 POPCORN AUTO — HIGGSFIELD", flush=True)

    params = extract_params(raw)
    print(f"📝 Prompt: {params['prompt'][:120]}…", flush=True)
    print(f"🎬 {params['num_images']} imágenes · {params['aspect_ratio']} · {params['resolution']}", flush=True)

    MAX_ATTEMPTS = 3
    image_urls   = []
    last_error   = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if attempt > 1:
            wait = 30 * (attempt - 1)
            print(f"  🔄 Reintento {attempt}/{MAX_ATTEMPTS} en {wait}s…", flush=True)
            time.sleep(wait)
        try:
            request_id = submit_popcorn(
                prompt       = params["prompt"],
                num_images   = params["num_images"],
                aspect_ratio = params["aspect_ratio"],
                resolution   = params["resolution"],
                image_urls   = params["image_urls"],
                api_key      = api_key,
            )
            image_urls = poll_images(request_id, api_key)
            break  # éxito — salir del loop
        except _ServerFailedError as e:
            # Error de servidor de Higgsfield — reintentable
            last_error = e
            print(f"  ⚠️  Intento {attempt} falló (servidor): {e}", flush=True)
            if attempt == MAX_ATTEMPTS:
                print(f"❌ Error tras {MAX_ATTEMPTS} intentos: {e}", file=sys.stderr)
                sys.exit(1)
        except Exception as e:
            # Error no reintentable (NSFW, cancelado, prompt inválido…)
            print(f"❌ Error: {e}", file=sys.stderr)
            sys.exit(1)

    print(f"\n✅ {len(image_urls)} imágenes generadas por Popcorn", flush=True)

    # Output estructurado
    lines = [f"# 🍿 IMÁGENES GENERADAS — Higgsfield Popcorn Auto\n"]
    lines.append(f"**{len(image_urls)} imágenes coherentes generadas**")
    lines.append(f"**Prompt:** {params['prompt'][:200]}")
    lines.append(f"**Formato:** {params['aspect_ratio']} · {params['resolution']}\n")

    for i, url in enumerate(image_urls):
        lines.append(f"## 🖼️ Escena {i + 1}")
        lines.append(f"**URL:** {url}")
        lines.append(f"![Escena {i + 1}]({url})")
        lines.append("")

    # JSON estructurado para el siguiente agente (Video Prompt Generator / Imagen Video)
    output_json = {
        "image_urls":   image_urls,
        "prompt":       params["prompt"],
        "aspect_ratio": params["aspect_ratio"],
        "resolution":   params["resolution"],
        "num_images":   len(image_urls),
        "source":       "popcorn_auto",
    }
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    output = "\n".join(lines)
    print(output, flush=True)
    post_issue_result(output)


if __name__ == "__main__":
    main()
