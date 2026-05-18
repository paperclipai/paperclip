"""
Agente: Imagen Video (Higgsfield DoP Turbo — First-Last Frame)
Genera clips cinematográficos a partir de pares de imágenes consecutivas.

Con N imágenes de Popcorn → N-1 clips encadenados, donde cada clip
transiciona suavemente de una escena a la siguiente.

Docs: https://docs.higgsfield.ai
Auth: Authorization: Key {KEY_ID}:{KEY_SECRET}
Submit: POST https://platform.higgsfield.ai/higgsfield-ai/dop/turbo/first-last-frame
Poll:   GET  https://platform.higgsfield.ai/requests/{id}/status
Result: video.url cuando status == "completed"

Input: JSON con image_urls[] del agente Popcorn (o imagen.py)
Output: URLs de clips MP4 + lanza Video Assembler con los clips reales.
"""
import os
import sys
import json
import time
import re
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, post_parent_update, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BASE_URL  = "https://platform.higgsfield.ai"
ENDPOINT_LITE     = "higgsfield-ai/dop/lite/first-last-frame"     # 2 cr  — básico
ENDPOINT_TURBO    = "higgsfield-ai/dop/turbo/first-last-frame"    # 6.5 cr — rápido
ENDPOINT_STANDARD = "higgsfield-ai/dop/standard/first-last-frame" # 9 cr  — mejor calidad

DONE_STATUSES    = {"completed", "failed", "nsfw", "canceled"}
SUCCESS_STATUSES = {"completed"}

_motions_cache: list | None = None

def _fetch_motions_catalog(api_key: str) -> list:
    global _motions_cache
    if _motions_cache is not None:
        return _motions_cache
    try:
        data = http_get(f"{BASE_URL}/v1/motions", api_key)
        _motions_cache = data if isinstance(data, list) else data.get("motions", [])
        print(f"  📚 Catálogo de motions cargado: {len(_motions_cache)} entradas", flush=True)
    except Exception as e:
        print(f"  ⚠️  No se pudo cargar catálogo de motions: {e}", flush=True)
        _motions_cache = []
    return _motions_cache

def _resolve_motion(motion_name: str, api_key: str) -> dict:
    catalog = _fetch_motions_catalog(api_key)
    for m in catalog:
        if m.get("name", "").lower() == motion_name.lower():
            return {"id": m["id"], "name": m["name"], "strength": 1.0}
    # Fallback: si no está en el catálogo, intentar con slug como id
    return {"id": motion_name.lower().replace(" ", "_"), "name": motion_name, "strength": 1.0}

# ── Motion presets por género ─────────────────────────────────────────────────
# Cada lista = [apertura, desarrollo, tensión, clímax, resolución]
# El sistema escala dinámicamente para cualquier número de clips.
GENRE_PRESETS: dict[str, list] = {
    "horror": [
        ["Handheld"],           # apertura  — found footage
        ["Dutch Angle"],        # desarrollo — desasosiego
        ["Crash Zoom In"],      # tensión    — shock
        ["Snorricam"],          # clímax     — persecución, terror
        ["Dolly Out"],          # resolución — alejamiento
    ],
    "conspiracion": [
        ["Handheld"],           # apertura   — documental crudo
        ["Dutch Angle"],        # desarrollo — paranoia
        ["Crash Zoom In"],      # tensión    — revelación
        ["Dolly Zoom In"],      # clímax     — efecto Hitchcock
        ["Crane Up"],           # resolución — perspectiva
    ],
    "accion": [
        ["FPV Drone"],          # apertura   — inmersivo
        ["Action Run"],         # desarrollo — energía
        ["Whip Pan"],           # tensión    — corte rápido
        ["Crash Zoom In"],      # clímax     — impacto
        ["Crane Up", "Dolly Out"], # resolución
    ],
    "misterio": [
        ["Dolly In"],           # apertura   — acercamiento
        ["Focus Change"],       # desarrollo — intriga
        ["Snorricam"],          # tensión    — inestabilidad
        ["Crash Zoom In"],      # clímax     — descubrimiento
        ["Crane Up"],           # resolución
    ],
    "drama": [                  # default fallback
        ["Dolly In"],
        ["Arc Right", "Focus Change"],
        ["Crash Zoom In"],
        ["Crane Up", "Dolly Out"],
        ["Dolly In"],
    ],
}

# Fallback si el género no está en el dict
NARRATIVE_MOTIONS = GENRE_PRESETS["drama"]

# ── Motions compatibles con First-Last Frame (FLF) ───────────────────────────
# SOLO movimientos de cámara y personaje confirmados.
# Efectos visuales (VHS, Glitch, Static, Datamosh, Innerlight, Disintegration,
# Melting, Clone Explosion, Fisheye, Lens Crack) NO son compatibles con FLF.
AVAILABLE_MOTIONS_FOR_LLM = [
    # Cámara — todos compatibles con FLF
    "Dolly In", "Dolly Out", "Dolly Zoom In", "Dolly Zoom Out",
    "Arc Left", "Arc Right",
    "Crane Up", "Crane Down",
    "Crash Zoom In", "Crash Zoom Out",
    "Super Dolly In", "Super Dolly Out",
    "FPV Drone", "Handheld", "Overhead",
    "Snorricam", "Whip Pan",
    "Tilt Down", "Tilt up",
    "Dutch Angle", "Zoom In", "Zoom Out",
    # Efectos compatibles con FLF (confirmados)
    "Focus Change", "Lens Flare", "Paparazzi",
    # Personaje — compatibles con FLF
    "Action Run", "Catwalk", "Levitation", "Agent Reveal", "Soul Jump",
    # General
    "General",
]

# Prompt de texto complementario (breve, DoP prioriza los motions)
TRANSITION_PROMPT = "Cinematic dramatic scene. Artistic composition, atmospheric lighting, photorealistic style. Smooth transition."


def select_motions(clip_index: int, total_clips: int, genre: str = "drama") -> list:
    """
    Selecciona motions según género + posición narrativa.
    Escala dinámicamente para cualquier número de clips.
    """
    if total_clips == 1:
        return ["Dolly In"]
    preset = GENRE_PRESETS.get(genre, GENRE_PRESETS["drama"])
    ratio  = clip_index / max(total_clips - 1, 1)
    if ratio < 0.20:   return preset[0]   # apertura
    elif ratio < 0.45: return preset[1]   # desarrollo
    elif ratio < 0.70: return preset[2]   # tensión
    elif ratio < 0.85: return preset[3]   # clímax
    else:              return preset[4]   # resolución


def select_all_motions_llm(
    scene_contexts: list,
    genre: str,
    n_clips: int,
    api_key: str,
) -> list[list]:
    """
    Usa LLM (una sola llamada) para asignar el mejor motion a cada clip
    basándose en la descripción de la escena + el género.
    Devuelve lista de listas: [[motion_clip_0], [motion_clip_1], ...]
    Si falla, devuelve lista vacía (el caller usa el preset de género).
    """
    if not api_key or not scene_contexts:
        return []

    motions_str = ", ".join(AVAILABLE_MOTIONS_FOR_LLM)
    scenes_str  = "\n".join(
        f"Clip {i+1}: {scene_contexts[i] if i < len(scene_contexts) else '(escena de transición)'}"
        for i in range(n_clips)
    )

    prompt = f"""Eres un director de fotografía especialista en content viral.
Género del video: {genre}
Motions disponibles: {motions_str}

Asigna el motion MÁS APROPIADO para cada clip según lo que ocurre en la escena.
- Si hay un personaje corriendo → Action Run
- Si es un momento de shock/revelación → Crash Zoom In
- Si es sobrenatural/horror → Disintegration, Melting, Clone Explosion
- Si es documental/found footage → Handheld
- Si es paranoia/conspiración → Dutch Angle, Fisheye, Datamosh
- Si es calma/inicio → Dolly In
- Para el clímax del género {genre} usa el motion más dramático disponible

Escenas:
{scenes_str}

Responde SOLO con JSON (sin markdown):
{{"motions": ["motion_clip_1", "motion_clip_2", ...]}}
La lista debe tener exactamente {n_clips} elementos."""

    try:
        response = call_llm(
            messages=[{"role": "user", "content": prompt}],
            api_key     = api_key,
            max_tokens  = 300,
            temperature = 0.4,
            title       = "Imagen Video - Motion Selection",
            model       = "anthropic/claude-3-5-haiku",
            timeout     = 15,
            retries     = 0,
        )
        clean = response.strip()
        if "```" in clean:
            clean = clean.split("```")[1] if "```json" not in clean else clean.split("```json")[1].split("```")[0]
        data    = json.loads(clean.strip())
        motions = data.get("motions", [])
        if len(motions) == n_clips:
            # Validar que todos los motions existen
            validated = []
            for m in motions:
                if m in AVAILABLE_MOTIONS_FOR_LLM:
                    validated.append([m])
                else:
                    validated.append(None)  # None = usar preset
            print(f"  🤖 LLM motions: {[m[0] if m else '(preset)' for m in validated]}", flush=True)
            return validated
    except Exception as e:
        print(f"  ⚠️  LLM motion selection falló: {e} — usando preset de género", flush=True)
    return []

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
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(url, data=data, headers=make_headers(api_key), method="POST")
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


def submit_clip(image_url: str, end_image_url: str, prompt: str,
                api_key: str, motions: list = None, endpoint: str = None,
                duration: int = 5) -> str:
    """
    Envía un par de imágenes (primer y último frame) a DoP (Turbo o Lite).
    motions: lista de nombres de motion (ej. ["Dolly In", "Focus Change"]).
    duration: duración del clip en segundos (3-8). Default 5s.
    Devuelve request_id.
    """
    url = f"{BASE_URL}/{endpoint or ENDPOINT_TURBO}"
    # La API ahora requiere {id, name, strength} por motion
    motions_payload = [_resolve_motion(m, api_key) for m in motions] if motions else []
    payload = {
        "image_url":      image_url,
        "end_image_url":  end_image_url,
        "prompt":         prompt,
        "enhance_prompt": True,
        "duration":       duration,
    }
    if motions_payload:
        payload["motions"] = motions_payload
    print(f"  📡 POST {url}", flush=True)
    print(f"  🖼️  {image_url[:55]}… → {end_image_url[:55]}…", flush=True)
    print(f"  🎬 Motions: {motions}  ⏱️  {duration}s", flush=True)

    result = http_post(url, payload, api_key)
    request_id = result.get("request_id")
    if not request_id:
        raise Exception(f"Sin request_id en respuesta: {json.dumps(result)[:300]}")
    print(f"  📤 En cola → ID: {request_id}", flush=True)
    return request_id


def poll_clip(request_id: str, api_key: str, max_wait: int = 180) -> str:
    """Polling hasta obtener la URL del clip MP4. Timeout 3 min por clip."""
    deadline   = time.time() + max_wait
    interval   = 6
    status_url = f"{BASE_URL}/requests/{request_id}/status"

    while time.time() < deadline:
        data   = http_get(status_url, api_key)
        status = (data.get("status") or "unknown").lower()
        print(f"  ⏳ {request_id[:12]}… → {status}", flush=True)

        if status in SUCCESS_STATUSES:
            video_url = (
                (data.get("video") or {}).get("url")
                or (data.get("videos") or [{}])[0].get("url")
                or data.get("video_url")
                or (data.get("output") or {}).get("video_url")
            )
            if video_url:
                return video_url
            raise Exception(f"completed pero sin video URL: {json.dumps(data)[:300]}")

        if status == "nsfw":
            raise Exception("Clip rechazado por moderación (NSFW).")
        if status in ("failed", "canceled"):
            raise Exception(f"Generación fallida ({status}): {data.get('error', '')}")

        time.sleep(interval)

    raise Exception(f"Timeout ({max_wait}s) esperando clip {request_id}")


def generate_transition_clip(
    idx: int,
    image_url: str,
    end_image_url: str,
    api_key: str,
    motions: list = None,
    max_retries: int = 0,
    endpoint: str = None,
    duration: int = 5,
) -> dict:
    """Genera un clip de transición entre dos imágenes con motions y reintentos."""
    label = f"Clip {idx} (escena {idx}→{idx + 1})"
    print(f"\n🎞️  {label}…", flush=True)
    last_error = None

    for attempt in range(1, max_retries + 2):
        if attempt > 1:
            wait = 20 * (attempt - 1)
            print(f"  🔄 Reintento {attempt} en {wait}s…", flush=True)
            time.sleep(wait)
        try:
            request_id = submit_clip(
                image_url, end_image_url,
                TRANSITION_PROMPT, api_key,
                motions=motions,
                endpoint=endpoint,
                duration=duration,
            )
            video_url = poll_clip(request_id, api_key)
            print(f"  ✅ {label} → {video_url[:80]}", flush=True)
            return {
                "clip":          idx,
                "image_url":     image_url,
                "end_image_url": end_image_url,
                "motions":       motions,
                "video_url":     video_url,
                "status":        "ok",
            }
        except Exception as e:
            last_error = e
            print(f"  ⚠️  Intento {attempt} fallido: {e}", flush=True)
            if "concurrent" in str(e).lower() or "HTTP 400" in str(e):
                time.sleep(25)

    print(f"  ❌ {label} falló tras {max_retries + 1} intentos", flush=True)
    return {
        "clip":          idx,
        "image_url":     image_url,
        "end_image_url": end_image_url,
        "motions":       motions,
        "video_url":     None,
        "status":        f"error: {last_error}",
    }


def extract_image_urls(raw: str) -> list:
    """
    Extrae image_urls[] del JSON de Popcorn/Imagen o del texto libre.
    Prioridad: JSON con image_urls[] > markdown images > URLs directas.
    """
    # 1. Buscar JSON estructurado (output de Popcorn)
    for pattern in (r'```json\s*([\s\S]+?)```', r'(\{[\s\S]*?"image_urls"[\s\S]*?\})'):
        m = re.search(pattern, raw)
        if m:
            try:
                data = json.loads(m.group(1))
                urls = data.get("image_urls") or data.get("video_clips") or []
                if urls:
                    print(f"  ✅ {len(urls)} URLs extraídas del JSON", flush=True)
                    return urls
            except Exception:
                pass

    # 2. Fallback: buscar URLs de imagen en el texto
    seen, result = set(), []
    for u in re.findall(r'https?://[^\s"\')\]]+\.(?:png|jpg|jpeg|webp)', raw, re.I):
        if u not in seen:
            seen.add(u)
            result.append(u)
    # también markdown ![](url)
    for u in re.findall(r'\]\((https?://[^\s)]+)\)', raw):
        if u not in seen and any(ext in u.lower() for ext in ('.png','.jpg','.jpeg','.webp')):
            seen.add(u)
            result.append(u)

    if result:
        print(f"  ℹ️  {len(result)} URLs extraídas del texto libre", flush=True)
    return result


def launch_video_assembler(clip_urls: list, assembler_params: dict,
                           fallback_image_urls: list = None) -> None:
    """
    Lanza video_assembler.py como proceso detachado con los clips reales.
    Se ejecuta DESPUÉS de que todos los clips están listos.
    fallback_image_urls: las image_urls originales de Popcorn, para uso
    como fallback en el assembler si no hay clips (no las ponemos en
    assembler_params para no superar el límite de 4000 chars del sub-issue).
    """
    import subprocess as _sub

    script_dir = os.path.dirname(os.path.abspath(__file__))
    script     = os.path.join(script_dir, "video_assembler.py")

    task = json.dumps({
        "video_clips":     clip_urls,
        "image_urls":      fallback_image_urls or assembler_params.get("image_urls", []),
        "audio_path":      assembler_params.get("audio_path", ""),
        "audio_url":       assembler_params.get("audio_url", ""),
        "tema":            assembler_params.get("tema", ""),
        "narration_text":  assembler_params.get("narration_text", ""),
    }, ensure_ascii=False)

    env = {**os.environ}
    env.pop("PAPERCLIP_ISSUE_ID",    None)
    env.pop("PAPERCLIP_ISSUE_TITLE", None)
    env.pop("PAPERCLIP_ISSUE_BODY",  None)

    mode = f"{len(clip_urls)} clips animados" if clip_urls else "imágenes como fallback"
    print(f"\n🎬 Lanzando Video Assembler ({mode})…", flush=True)
    try:
        proc = _sub.Popen(
            [sys.executable, script],
            stdin=_sub.PIPE,
            start_new_session=True,
            env=env,
        )
        proc.stdin.write(task.encode("utf-8"))
        proc.stdin.close()
        print(f"  🚀 Video Assembler lanzado en background (PID {proc.pid})", flush=True)
    except Exception as e:
        print(f"  ⚠️  No se pudo lanzar Video Assembler: {e}", flush=True)


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

    # ── Extraer PARENT_ISSUE_ID ───────────────────────────────
    _parent_match = re.search(r'PARENT_ISSUE_ID:([^\n\s>]+)', raw)
    if _parent_match:
        os.environ['PAPERCLIP_PARENT_ISSUE_ID'] = _parent_match.group(1).strip()
        raw = raw.replace(_parent_match.group(0), '').strip()
        raw = re.sub(r'<!--[^>]*-->', '', raw).strip()
        print(f"  🔗 Parent issue ID: {os.environ['PAPERCLIP_PARENT_ISSUE_ID'][:12]}…", flush=True)

    # ── Extraer ASSEMBLER_PARAMS ──────────────────────────────
    assembler_params = None
    _asm_match = re.search(r'ASSEMBLER_PARAMS:(\{[^\n]+\})', raw)
    if _asm_match:
        try:
            assembler_params = json.loads(_asm_match.group(1))
            raw = raw.replace(_asm_match.group(0), '').strip()
            print(f"  📦 Assembler params: audio={bool(assembler_params.get('audio_url'))}", flush=True)
        except Exception as e:
            print(f"  ⚠️  No se pudo parsear ASSEMBLER_PARAMS: {e}", flush=True)

    if not raw:
        print("ERROR: Sin input", file=sys.stderr)
        sys.exit(1)

    # ── Elegir modelo DoP (turbo | lite | standard) ───────────
    dop_model_override = None
    _model_match = re.search(r'"dop_model"\s*:\s*"([^"]+)"', raw)
    if _model_match:
        dop_model_override = _model_match.group(1).strip().lower()
        raw = re.sub(r',?\s*"dop_model"\s*:\s*"[^"]+"', '', raw)
    if dop_model_override == "turbo":
        dop_endpoint = ENDPOINT_TURBO
        model_label  = "Turbo (6.5 cr/clip)"
    elif dop_model_override == "standard":
        dop_endpoint = ENDPOINT_STANDARD
        model_label  = "Standard (9 cr/clip)"
    else:
        dop_endpoint = ENDPOINT_LITE
        model_label  = "Lite (2 cr/clip)"
    print(f"🎞️  IMAGEN VIDEO — DoP {model_label.upper()}", flush=True)

    if issue_title:
        post_issue_comment(
            f"🎞️ Generando clips cinematográficos para: **{issue_title}**\n\n"
            f"Modelo: **DoP {model_label}** — transiciones fluidas entre pares de imágenes. "
            f"Puede tardar 3-6 min."
        )

    # ── Extraer género y contextos de escena (del Director) ──────
    genre_input   = "drama"
    scene_contexts = []
    _genre_match  = re.search(r'"genre"\s*:\s*"([^"]+)"', raw)
    if _genre_match:
        genre_input = _genre_match.group(1).strip().lower()
        raw = re.sub(r',?\s*"genre"\s*:\s*"[^"]+"', '', raw)
    _scene_match = re.search(r'"scene_contexts"\s*:\s*(\[[^\]]*\])', raw)
    if _scene_match:
        try:
            scene_contexts = json.loads(_scene_match.group(1))
        except Exception:
            scene_contexts = []
        raw = re.sub(r',?\s*"scene_contexts"\s*:\s*\[[^\]]*\]', '', raw)
    if genre_input not in GENRE_PRESETS:
        genre_input = "drama"
    print(f"  🎭 Género: {genre_input} | Escenas: {len(scene_contexts)}", flush=True)

    # ── Extraer dop_motion override (si viene de Studio) ──────
    dop_motion_override = None
    _dop_match = re.search(r'"dop_motion"\s*:\s*"([^"]+)"', raw)
    if _dop_match:
        dop_motion_override = _dop_match.group(1).strip()
        print(f"  🎬 Motion override manual: {dop_motion_override}", flush=True)
        raw = re.sub(r',?\s*"dop_motion"\s*:\s*"[^"]+"', '', raw)

    # ── Extraer target_duration (duración objetivo del video en segundos) ──
    target_duration = 0
    _tdur_match = re.search(r'"target_duration"\s*:\s*(\d+)', raw)
    if _tdur_match:
        target_duration = int(_tdur_match.group(1))
        raw = re.sub(r',?\s*"target_duration"\s*:\s*\d+', '', raw)
        print(f"  ⏱️  Duración objetivo recibida: {target_duration}s", flush=True)

    # ── Extraer imágenes de entrada ───────────────────────────
    image_urls = extract_image_urls(raw)

    if len(image_urls) < 2:
        msg = f"ERROR: Se necesitan al menos 2 imágenes para First-Last Frame (recibidas: {len(image_urls)})"
        print(msg, file=sys.stderr)
        sys.exit(1)

    # Máximo 16 imágenes → 15 clips → ~75s de video
    MAX_IMAGES = 16
    if len(image_urls) > MAX_IMAGES:
        print(f"  ℹ️  Limitando a {MAX_IMAGES} imágenes ({len(image_urls)} recibidas)", flush=True)
        image_urls = image_urls[:MAX_IMAGES]

    # Construir pares consecutivos: (img0→img1), (img1→img2), ...
    pairs = [(image_urls[i], image_urls[i + 1]) for i in range(len(image_urls) - 1)]
    n_clips = len(pairs)

    # ── Calcular duración por clip ────────────────────────────
    # Si llega target_duration (del storytelling), dividir entre clips.
    # Si no, usar 5s por defecto (vs ~3s default de la API).
    # Rango válido: 3–8 segundos.
    if target_duration > 0 and n_clips > 0:
        # ceil(target / clips) para asegurar que el video llegue al objetivo
        clip_duration = min(8, max(3, -(-target_duration // n_clips)))
        print(f"  ⏱️  Duración por clip: {clip_duration}s ({n_clips} clips → ~{clip_duration * n_clips}s total)", flush=True)
    else:
        clip_duration = 5  # 5s default → 15 clips × 5s = 75s
        print(f"  ⏱️  Duración por clip: {clip_duration}s (default)", flush=True)

    print(f"\n🚀 Generando {n_clips} clips (género: {genre_input})…", flush=True)

    # ── Selección inteligente de motions ──────────────────────
    # Si hay override manual de Studio → usarlo para todos
    # Si no → LLM asigna por escena + preset de género como fallback
    llm_motions: list = []
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not dop_motion_override and scene_contexts and openrouter_key:
        print(f"  🤖 LLM seleccionando motions por escena…", flush=True)
        llm_motions = select_all_motions_llm(scene_contexts, genre_input, n_clips, openrouter_key)

    # Mostrar plan de motions
    for i in range(n_clips):
        if dop_motion_override:
            m = [dop_motion_override]
        elif llm_motions and i < len(llm_motions) and llm_motions[i]:
            m = llm_motions[i]
        else:
            m = select_motions(i, n_clips, genre_input)
        print(f"  📋 Clip {i+1}: {m}  {clip_duration}s", flush=True)

    results = [None] * n_clips

    def run(idx, first_url, last_url):
        if dop_motion_override:
            motions = [dop_motion_override]
        elif llm_motions and idx < len(llm_motions) and llm_motions[idx]:
            motions = llm_motions[idx]
        else:
            motions = select_motions(idx, n_clips, genre_input)
        return idx, generate_transition_clip(
            idx           = idx + 1,
            image_url     = first_url,
            end_image_url = last_url,
            api_key       = api_key,
            motions       = motions,
            endpoint      = dop_endpoint,
            duration      = clip_duration,
        )

    # Lotes de 2 clips: menos presión sobre el límite de concurrencia de Higgsfield.
    # Con 3 se acumulaban rechazos si un clip del lote anterior tardaba más.
    BATCH_SIZE = 2
    for _batch_start in range(0, n_clips, BATCH_SIZE):
        _batch = pairs[_batch_start:_batch_start + BATCH_SIZE]
        _batch_num = _batch_start // BATCH_SIZE + 1
        _total_batches = (n_clips + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"\n  📦 Lote {_batch_num}/{_total_batches} ({len(_batch)} clips)…", flush=True)
        if _batch_start > 0:
            time.sleep(5)  # pausa entre lotes para no saturar concurrencia
        with ThreadPoolExecutor(max_workers=BATCH_SIZE) as executor:
            futures = {
                executor.submit(run, _batch_start + i, f, l): _batch_start + i
                for i, (f, l) in enumerate(_batch)
            }
            for future in as_completed(futures):
                idx, result = future.result()
                results[idx] = result
                icon = "✅" if result["status"] == "ok" else "❌"
                print(f"  {icon} Clip {result['clip']} completado", flush=True)

    # ── Pase de recuperación: reintentar clips fallidos ───────
    # Si Higgsfield estaba sobrecargado durante el run principal,
    # algunos clips pudieron fallar los 2 intentos. Los reintentamos
    # de uno en uno con más espera (no en paralelo para no saturar).
    failed_indices = [i for i, r in enumerate(results) if not r or r["status"] != "ok"]
    ok_first_pass  = n_clips - len(failed_indices)

    # Solo recuperar si al menos el 40% de los clips del primer pase salieron bien
    # y hay menos de 5 clips fallidos. Si hay demasiados fallos, Higgsfield está
    # inestable y reintentar solo gasta más créditos sin garantía de éxito.
    MAX_RECOVERY = 4
    if failed_indices and ok_first_pass >= n_clips * 0.4 and len(failed_indices) <= MAX_RECOVERY:
        print(f"\n  🔁 Pase de recuperación: {len(failed_indices)} clip(s) fallido(s)…", flush=True)
        time.sleep(20)  # dar respiro a Higgsfield antes de reintentar
        for i in failed_indices[:MAX_RECOVERY]:
            first_url, last_url = pairs[i]
            print(f"  🔄 Reintentando clip {i+1}…", flush=True)
            _, result = run(i, first_url, last_url)
            results[i] = result
            icon = "✅" if result["status"] == "ok" else "❌"
            print(f"  {icon} Recuperación clip {i+1}: {result['status']}", flush=True)
            if result["status"] != "ok":
                time.sleep(15)
    elif failed_indices:
        print(f"\n  ⚠️  {len(failed_indices)} clips fallidos — omitiendo recuperación "
              f"(demasiados fallos o primer pase insuficiente). "
              f"El video se ensambla con los {ok_first_pass} clips disponibles.", flush=True)

    # ── Construir output ──────────────────────────────────────
    ok_count        = sum(1 for r in results if r and r["status"] == "ok")
    video_clip_urls = [r["video_url"] for r in results if r and r["video_url"]]

    lines = [f"# 🎞️ CLIPS GENERADOS — DoP {model_label} First-Last Frame\n"]
    lines.append(f"**{ok_count}/{len(results)} clips generados correctamente**")
    lines.append(f"**Imágenes usadas:** {len(image_urls)}  →  **Clips:** {len(pairs)}\n")

    for r in results:
        if not r:
            continue
        icon = "✅" if r["status"] == "ok" else "❌"
        motions_str = ", ".join(r.get("motions") or []) or "—"
        lines.append(f"## {icon} Clip {r['clip']} — {motions_str}")
        if r["video_url"]:
            lines.append(f"**VIDEO_CLIP:** {r['video_url']}")
            lines.append(f"![Clip {r['clip']}]({r['video_url']})")
        else:
            lines.append(f"**Error:** {r['status']}")
            lines.append(f"**Fallback frame 1:** {r['image_url']}")
        lines.append("")

    lines.append("```json")
    lines.append(json.dumps({
        "video_clips":     video_clip_urls,
        "fallback_images": image_urls,
        "results":         results,
    }, indent=2, ensure_ascii=False))
    lines.append("```")

    output = "\n".join(lines)
    print(output, flush=True)

    post_issue_result(output)
    post_parent_update("imagen_video", output)

    # ── Lanzar Video Assembler con clips reales ───────────────
    if assembler_params is not None:
        if video_clip_urls:
            print(f"\n✅ {len(video_clip_urls)} clips listos → lanzando Video Assembler", flush=True)
        else:
            print(f"\n⚠️  Sin clips — Video Assembler usará imágenes como fallback", flush=True)
        launch_video_assembler(video_clip_urls, assembler_params,
                               fallback_image_urls=image_urls)
    else:
        print("\nℹ️  Sin ASSEMBLER_PARAMS — Video Assembler no lanzado desde aquí", flush=True)


if __name__ == "__main__":
    main()
