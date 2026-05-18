"""
Agente: Director de Contenido
Orquestador principal que coordina los 5 agentes especializados.
Recibe un objetivo de alto nivel y devuelve un paquete completo de contenido.

Flujo:
1. Deep Search      → tendencias + keywords virales
2. Channel Analyzer → análisis de competencia
3. Storytelling     → guión completo del video (4-5 escenas)
4. Prompt Generator → prompts JSON para 5-6 imágenes
5. Imagen Generator → imágenes reales con Higgsfield Soul

Cada agente crea un sub-issue visible en el inbox de Paperclip.
"""
import os
import sys
import json
import subprocess
import hmac
import hashlib
import base64
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from api_client import call_llm, post_issue_comment
from db_client import save_video, update_video, is_configured as db_configured

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# ── IDs de los sub-agentes registrados en Paperclip ─────────────────────────
SUB_AGENT_IDS = {
    "source_reader":        "a6cc7b6e-cde3-4464-9cbf-3241b979dc6b",
    "deep_search":          "a1d8d0b8-9ada-4980-9b5f-663b34ba2c80",
    "channel_analyzer":     "0f784ca9-93b0-4384-ba7c-1e079bb8797b",
    "storytelling":         "061ed6b8-27b1-4a31-8758-19af856b45d3",
    "prompt_generator":     "64e2cb07-75e1-4ca2-8b6c-05a78b66613f",
    "imagen_generator":     "2492962a-b9f0-4611-90e2-c7ccca5aa281",
    "popcorn":              os.environ.get("POPCORN_AGENT_ID", ""),
    "video_prompt_generator": os.environ.get("VIDEO_PROMPT_GENERATOR_AGENT_ID",
                                             "9d4d8bf2-8f0b-48df-a189-da6a12911437"),
    "imagen_video":         os.environ.get("IMAGEN_VIDEO_AGENT_ID",
                                           "62e14c73-905b-45ce-b4d9-4cd532ec3dca"),
    "tts":                  "0d43b313-77b5-481b-83cc-a41485823f8e",
    "video_assembler":      "28f0a4aa-a230-4d82-aedf-4c327ab4a506",
}

AGENTS_DIR = Path(__file__).parent
PYTHON = sys.executable

SYNTHESIS_PROMPT = """Eres el Director Creativo de un canal de TikTok/YouTube en español que ya tiene millones de vistas. Recibes los reportes completos de 4 agentes especializados (tendencias, análisis de competencia, guión y referencias visuales) y los conviertes en un brief de producción listo para ejecutar ahora mismo.

Tu síntesis no es un resumen burocrático. Es un documento de guerra creativa — conciso, específico, sin relleno, con el guión completo y las instrucciones exactas para que cualquier editor o creador lo tome y sepa exactamente qué hacer.

REGLAS ABSOLUTAS:
- CERO placeholders. Nada de [NOMBRE], [CIUDAD], [HASHTAG]. Escribe el contenido real.
- El HOOK son las primeras palabras EXACTAS que se dicen en cámara — no "algo que genere curiosidad", las palabras textuales.
- El GUIÓN completo viene del Reporte 3 (Storytelling). Cópialo íntegro, todas las escenas con su narración. No lo resumas.
- Adapta ABSOLUTAMENTE TODO al nicho: el tono del ejecutivo cambia entre drama personal, finanzas, tech o fitness.
- Los HASHTAGS son específicos para este video y nicho — no los genéricos de siempre.

## ESTRUCTURA OBLIGATORIA:

## 🎯 POR QUÉ ESTE VIDEO VA A FUNCIONAR
[3 razones específicas basadas en los datos de los reportes: qué tendencia aprovecha, qué emoción dominante activa, qué hace diferente a lo que ya existe en el nicho. Sin generalidades.]

## 🎬 BRIEF DE PRODUCCIÓN

**Título del video:** [exacto, máximo 8 palabras, que genere intriga o curiosidad irresistible]
**Duración objetivo:** [segundos exactos según el nicho y los datos del Channel Analyzer]
**Plataforma prioritaria:** [TikTok / YouTube Shorts / ambas — con justificación de 1 línea]
**Publicar a las:** [hora exacta en LATAM según el nicho y la audiencia]

---

### ⚡ HOOK — Las primeras palabras exactas
[Escribe literalmente las 2-3 primeras frases que abren el video. El espectador las oye antes de poder decidir si se queda. Deben ser las más fuertes del video entero.]

---

### 📜 GUIÓN COMPLETO
[Transcribe aquí el guión completo del Reporte 3 — Storytelling. Escena por escena, con la narración completa tal como se grabará. No resumas, no cambies la estructura. Si el storytelling agent no está disponible, escribe el guión completo desde cero basándote en los otros reportes.]

---

### 💬 CTA FINAL
[La frase exacta de cierre que dispara comentarios. Debe ser una pregunta personal, fácil de responder, que conecte la historia del video con la vida del espectador.]

---

## 📱 ESTRATEGIA DE PUBLICACIÓN

**Hashtags:** [10 hashtags específicos — mezcla de grandes (#viral, #parati) y de nicho (#dramasrelaciones, #historiasverdaderas)]
**Miniatura:** [descripción exacta de la imagen del thumbnail: qué se ve, expresión facial, texto overlay, colores]
**Primer comentario fijado:** [el comentario que el creador debe fijar para disparar la conversación]
**Respuesta a los primeros 3 comentarios:** [qué tipo de respuesta maximiza el engagement en la primera hora]

## 📊 INDICADORES DE ÉXITO
- Retención en segundo 3: objetivo >80%
- Drop-off crítico a vigilar: segundo [X según la estructura del guión]
- Comentario tipo que indica que el video está funcionando: "[frase que la audiencia usará]"
- Si en 2 horas no tiene [N] comentarios, considerar: [ajuste específico]
"""

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def fetch_yt_viral_titles(query: str, api_key: str, max_results: int = 8) -> str:
    """
    Obtiene los títulos más virales del nicho en YouTube (últimos 7 días).
    Devuelve un bloque de texto con los títulos reales para inyectar en los prompts.
    """
    if not api_key:
        return ""
    try:
        since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        params = {
            "key":               api_key,
            "part":              "snippet",
            "q":                 query,
            "type":              "video",
            "order":             "viewCount",
            "publishedAfter":    since,
            "maxResults":        max_results,
            "relevanceLanguage": "es",
            "regionCode":        "MX",
        }
        url = f"https://www.googleapis.com/youtube/v3/search?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read().decode("utf-8"))

        items = data.get("items", [])
        if not items:
            return ""

        # Obtener estadísticas de los videos
        video_ids = [i["id"]["videoId"] for i in items if i.get("id", {}).get("videoId")]
        if not video_ids:
            return ""

        stats_params = {"key": api_key, "part": "statistics,snippet", "id": ",".join(video_ids)}
        stats_url = f"https://www.googleapis.com/youtube/v3/videos?{urllib.parse.urlencode(stats_params)}"
        stats_req = urllib.request.Request(stats_url, headers={"Accept": "application/json"}, method="GET")
        with urllib.request.urlopen(stats_req, timeout=12) as r:
            stats_data = json.loads(r.read().decode("utf-8"))

        lines = ["🎬 TÍTULOS VIRALES REALES DE YOUTUBE (últimos 7 días):"]
        for v in stats_data.get("items", []):
            title   = v.get("snippet", {}).get("title", "")
            views   = int(v.get("statistics", {}).get("viewCount", 0))
            channel = v.get("snippet", {}).get("channelTitle", "")
            if title and views > 0:
                views_fmt = f"{views/1_000_000:.1f}M" if views >= 1_000_000 else f"{views/1_000:.0f}K"
                lines.append(f'  • "{title}" — {views_fmt} views ({channel})')

        return "\n".join(lines) if len(lines) > 1 else ""
    except Exception as e:
        print(f"  ⚠️  YouTube Director API error: {e}", flush=True)
        return ""


def create_agent_jwt(agent_id: str, company_id: str, run_id: str, secret: str) -> str:
    """Genera un JWT local firmado con HMAC-SHA256 para autenticar contra la API de Paperclip."""
    header  = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":"))
    now     = int(time.time())
    payload = json.dumps({
        "sub":          agent_id,
        "company_id":   company_id,
        "adapter_type": "process",
        "run_id":       run_id,
        "iat":          now,
        "exp":          now + 172800,  # 48 h
        "iss":          "paperclip",
        "aud":          "paperclip-api",
    }, separators=(",", ":"))
    signing_input = f"{b64url(header.encode())}.{b64url(payload.encode())}"
    sig = hmac.new(secret.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(sig)}"


def sanitize(text: str) -> str:
    """Elimina caracteres surrogate y problemáticos para JSON/HTTP."""
    return text.encode("utf-8", errors="replace").decode("utf-8").replace("\x00", "")


# ── Paperclip Sub-Issue Helpers ──────────────────────────────────────────────

def _api_request(method: str, url: str, payload, headers: dict):
    """Hace una llamada HTTP a la API de Paperclip y devuelve el JSON de respuesta."""
    try:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: pass
        print(f"⚠️  API {method} {url} → HTTP {e.code}: {body[:300]}", flush=True)
        return None
    except Exception as e:
        print(f"⚠️  API {method} {url} → {e}", flush=True)
        return None


def ensure_agent_registered(agent_name: str, script: str, title: str,
                            api_url: str, auth_headers: dict, company_id: str,
                            reports_to_id: str = "") -> str:
    """Busca el agente por nombre en Paperclip. Si no existe, lo crea con adapterType='process'.
    Devuelve el UUID del agente (existente o recién creado), o "" si falla."""
    if not api_url or not company_id or "Authorization" not in auth_headers:
        return ""
    try:
        # 1. Listar agentes existentes
        data = _api_request("GET", f"{api_url}/api/companies/{company_id}/agents", None, auth_headers)
        existing_agents = data if isinstance(data, list) else (data or {}).get("agents", [])
        for ag in existing_agents:
            if isinstance(ag, dict) and ag.get("name", "").lower() == agent_name.lower():
                found_id = ag.get("id", "")
                print(f"  ✅ Agente '{agent_name}' ya existe → {found_id}", flush=True)
                return found_id
        # 2. Crear agente
        payload = {
            "name":               agent_name,
            "title":              title,
            "role":               "engineer",
            "adapterType":        "process",
            "adapterConfig":      {"command": "python", "args": [f"agents/{script}"], "cwd": "/app"},
            "budgetMonthlyCents": 6000,
        }
        if reports_to_id:
            payload["reportsTo"] = reports_to_id
        result = _api_request("POST", f"{api_url}/api/companies/{company_id}/agents",
                              payload, auth_headers)
        new_id = (result or {}).get("id", "")
        if new_id:
            print(f"  ✅ Agente '{agent_name}' creado → {new_id}", flush=True)
            print(f"  💡 Añade POPCORN_AGENT_ID={new_id} en Railway para persistirlo", flush=True)
        return new_id
    except Exception as e:
        print(f"⚠️  No se pudo registrar agente '{agent_name}': {e}", flush=True)
        return ""


def create_sub_issue(title: str, agent_key: str, parent_issue_id: str,
                     api_url: str, auth_headers: dict, company_id: str = "",
                     description: str = "", assignee_agent_id: str = ""):
    """Crea un sub-issue en Paperclip.
    - description: tarea del agente (inyectada como PAPERCLIP_ISSUE_BODY)
    - assignee_agent_id: ID del agente Paperclip que lo ejecutará
    Devuelve el ID del sub-issue creado, o None si falla."""
    if not parent_issue_id or not api_url:
        return None

    payload = {
        "title":    title,
        "status":   "backlog",
        "parentId": parent_issue_id,
    }
    if description:
        payload["description"] = description[:4000]
    if assignee_agent_id:
        payload["assigneeAgentId"] = assignee_agent_id

    url = f"{api_url}/api/companies/{company_id}/issues" if company_id else f"{api_url}/api/issues"
    print(f"  📋 Creando sub-issue: {title!r}", flush=True)
    result = _api_request("POST", url, payload, auth_headers)

    if result:
        sub_id = result.get("id") or result.get("issue", {}).get("id")
        if sub_id:
            print(f"  ✅ Sub-issue creado → ID: {sub_id}", flush=True)
            return sub_id
    print(f"  ⚠️  No se pudo crear sub-issue para {agent_key}", flush=True)
    return None


def _wait_for_sub_agent(sub_id: str, label: str, api_url: str,
                        auth_headers: dict, timeout: int = 240) -> str | None:
    """Espera a que Paperclip despache y complete el sub-agente.
    Devuelve el resultado (último comentario) o None si hay timeout."""
    deadline = time.time() + timeout
    last_log  = 0
    while time.time() < deadline:
        time.sleep(7)
        data = _api_request("GET", f"{api_url}/api/issues/{sub_id}", None, auth_headers)
        if data:
            status = data.get("status", "")
            if status == "done":
                comments = _api_request("GET", f"{api_url}/api/issues/{sub_id}/comments",
                                        None, auth_headers)
                if comments:
                    items = (comments if isinstance(comments, list)
                             else comments.get("comments") or comments.get("items") or [])
                    if items:
                        # Tomar el comentario más largo: es el resultado real del agente.
                        # La API puede devolver newest-first o oldest-first; el JSON/markdown
                        # del resultado siempre será mucho más largo que el mensaje de confirmación.
                        best = max(items, key=lambda c: len(c.get("body", "") or ""))
                        return best.get("body", "") or "[sin contenido]"
                return "[Agente terminó sin comentario de resultado]"
            elif status == "cancelled":
                return f"[{label}: cancelado]"
        if time.time() - last_log > 30:
            elapsed = int(time.time() - (deadline - timeout))
            print(f"  ⏳ Esperando {label}... ({elapsed}s/{timeout}s)", flush=True)
            last_log = time.time()
    return None  # timeout → activar fallback subprocess


def close_sub_issue(sub_issue_id: str, result_text: str,
                    api_url: str, auth_headers: dict) -> None:
    """Publica el resultado como comentario y cierra el sub-issue."""
    if not sub_issue_id:
        return

    # 1. Postear resultado como comentario en el sub-issue
    comment = result_text[:8000]  # límite prudente
    _api_request("POST", f"{api_url}/api/issues/{sub_issue_id}/comments",
                 {"body": comment}, auth_headers)

    # 2. Marcar sub-issue como done
    _api_request("PATCH", f"{api_url}/api/issues/{sub_issue_id}",
                 {"status": "done"}, auth_headers)

    print(f"  ✅ Sub-issue {sub_issue_id} cerrado con resultado", flush=True)


def run_agent_with_env(script_name: str, task: str, env: dict, label: str,
                       timeout: int = 120) -> str:
    """Ejecuta un agente especializado con un env personalizado."""
    script_path = AGENTS_DIR / script_name
    print(f"\n{'='*60}", flush=True)
    print(f"🤖 Ejecutando: {label}...", flush=True)
    print(f"{'='*60}", flush=True)

    env = {**env, "PYTHONIOENCODING": "utf-8"}

    try:
        result = subprocess.run(
            [PYTHON, str(script_path)],
            input=sanitize(task),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env
        )
        if result.returncode != 0:
            error_msg  = result.stderr.strip()
            stdout_tail = result.stdout.strip()[-600:]  # últimas líneas para debug ffmpeg
            print(f"⚠️  {label} falló (exit {result.returncode}): {error_msg[:300]}", flush=True)
            if stdout_tail:
                print(f"  📋 stdout (tail):\n{stdout_tail}", flush=True)
            return f"[{label}: Error - {error_msg[:200]}]"

        output = sanitize(result.stdout.strip())
        if not output:
            return f"[{label}: respuesta vacía]"
        print(f"✅ {label} completado ({len(output)} caracteres)", flush=True)
        return output

    except subprocess.TimeoutExpired:
        print(f"⏱️  {label} timeout ({timeout}s)", flush=True)
        return f"[{label}: Timeout]"
    except Exception as e:
        print(f"❌ {label} error inesperado: {e}", flush=True)
        return f"[{label}: {str(e)}]"


def run_agent(script_name: str, task: str, api_key: str, label: str) -> str:
    """Ejecuta un agente especializado y devuelve su output."""
    script_path = AGENTS_DIR / script_name
    print(f"\n{'='*60}", flush=True)
    print(f"🤖 Ejecutando: {label}...", flush=True)
    print(f"{'='*60}", flush=True)

    env = os.environ.copy()
    env["OPENROUTER_API_KEY"] = api_key
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        result = subprocess.run(
            [PYTHON, str(script_path)],
            input=sanitize(task),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            env=env
        )
        if result.returncode != 0:
            error_msg = result.stderr.strip()
            # stdout también para que aparezca en el log de la UI
            print(f"⚠️  {label} falló (exit {result.returncode}): {error_msg[:300]}", flush=True)
            return f"[{label}: Error - {error_msg[:200]}]"

        output = sanitize(result.stdout.strip())
        if not output:
            print(f"⚠️  {label} devolvió respuesta vacía. Stderr: {result.stderr.strip()[:200]}", flush=True)
            return f"[{label}: respuesta vacía]"
        print(f"✅ {label} completado ({len(output)} caracteres)", flush=True)
        return output

    except subprocess.TimeoutExpired:
        print(f"⏱️  {label} timeout (180s)", flush=True)
        return f"[{label}: Timeout - el agente tardó demasiado]"
    except Exception as e:
        print(f"❌ {label} error inesperado: {e}", flush=True)
        return f"[{label}: {str(e)}]"


def truncate_report(text: str, max_chars: int = 1500) -> str:
    """Recorta un reporte a max_chars, manteniendo inicio útil."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n\n[... {len(text) - max_chars} caracteres omitidos para síntesis ...]"


def synthesize(tema: str, reports: dict, api_key: str) -> str:
    """Llama al LLM para sintetizar todos los reportes en un paquete ejecutivo.
    Trunca cada reporte para no saturar el contexto del LLM y evitar timeouts."""
    content = f"""Tema del canal: {tema}

## REPORTE 1 - DEEP SEARCH (Tendencias y Keywords)
{truncate_report(reports['deep_search'], 1500)}

## REPORTE 2 - CHANNEL ANALYZER (Competencia)
{truncate_report(reports['channel_analyzer'], 1500)}

## REPORTE 3 - STORYTELLING DESIGNER (Guión completo — transcríbelo en el output)
{truncate_report(reports['storytelling'], 3500)}

## REPORTE 4 - PROMPT GENERATOR (Imágenes)
{truncate_report(reports['prompt_generator'], 800)}

---
Con base en estos 4 reportes, crea el paquete ejecutivo de contenido semanal.
Los reportes completos se adjuntarán al resultado final; aquí solo sintetiza lo esencial."""

    return call_llm(
        messages=[
            {"role": "system", "content": SYNTHESIS_PROMPT.format(tema=tema)},
            {"role": "user", "content": content}
        ],
        api_key=api_key,
        max_tokens=2000,
        temperature=0.6,
        title="Paperclip - Director de Contenido",
        model="anthropic/claude-sonnet-4-5",  # mejor calidad para síntesis
        timeout=60,
        retries=1,
    )


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    # Leer objetivo desde stdin o args (fallback)
    if len(sys.argv) > 1:
        objetivo = " ".join(sys.argv[1:])
    else:
        objetivo = sys.stdin.read().strip()

    # Leer contexto desde env (proceso local o adapter que los inyecta)
    issue_title = os.environ.get("PAPERCLIP_ISSUE_TITLE", "").strip()
    issue_body  = os.environ.get("PAPERCLIP_ISSUE_BODY", "").strip()

    print(f"🎯 DIRECTOR DE CONTENIDO INICIANDO", flush=True)

    # ── Configurar auth de Paperclip ──────────────────────────
    issue_id   = os.environ.get("PAPERCLIP_ISSUE_ID", "")
    api_url    = os.environ.get("PAPERCLIP_API_URL", "http://localhost:7777")
    agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "")
    company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
    run_id     = os.environ.get("PAPERCLIP_RUN_ID", "director-run")

    api_key_token = os.environ.get("PAPERCLIP_API_KEY", "")
    jwt_secret    = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or os.environ.get("BETTER_AUTH_SECRET", "")).strip()

    print(f"🔍 issue_id={issue_id!r}  api_key={'SET' if api_key_token else 'EMPTY'}  jwt_secret={'SET' if jwt_secret else 'EMPTY'}", flush=True)

    auth_headers: dict = {"Content-Type": "application/json"}
    if api_key_token:
        auth_headers["Authorization"] = f"Bearer {api_key_token}"
        print("🔑 Usando PAPERCLIP_API_KEY para autenticación", flush=True)
    elif jwt_secret and agent_id:
        try:
            token = create_agent_jwt(agent_id, company_id, run_id, jwt_secret)
            auth_headers["Authorization"] = f"Bearer {token}"
            print("🔑 JWT generado con BETTER_AUTH_SECRET", flush=True)
        except Exception as e:
            print(f"⚠️  No se pudo generar JWT: {e}", flush=True)
    else:
        print("⚠️  Sin token de autenticación disponible — sub-issues no se crearán", flush=True)

    # ── Auto-registrar agentes de proceso si no tienen UUID ───────
    if not SUB_AGENT_IDS.get("popcorn") and "Authorization" in auth_headers:
        print("🔧 POPCORN_AGENT_ID no configurado — intentando auto-registrar...", flush=True)
        _popcorn_id = ensure_agent_registered(
            agent_name="Popcorn Auto",
            script="popcorn.py",
            title="Higgsfield Coherent Image Generator",
            api_url=api_url,
            auth_headers=auth_headers,
            company_id=company_id,
            reports_to_id=agent_id,
        )
        if _popcorn_id:
            SUB_AGENT_IDS["popcorn"] = _popcorn_id

    # ── Obtener título del issue desde la API si no llegó por env ─
    # El wakeup de Paperclip solo pasa issueId en el payload, no el título.
    # PAPERCLIP_ISSUE_TITLE queda vacío → el Director siempre usaba el objetivo
    # por defecto. Solución: hacer GET del issue y leer su título real.
    if not issue_title and issue_id and "Authorization" in auth_headers:
        _issue_data = _api_request("GET", f"{api_url}/api/issues/{issue_id}", None, auth_headers)
        if _issue_data:
            issue_title = (_issue_data.get("title") or "").strip()
            issue_body  = (_issue_data.get("description") or "").strip()
            if issue_title:
                print(f"📥 Título obtenido de la API: {issue_title!r}", flush=True)

    # ── Construir objetivo final ───────────────────────────────
    import re as _re  # importar aquí para que esté disponible en todo el scope de main()

    if issue_title:
        objetivo = f"{issue_title}\n\n{issue_body}" if issue_body else issue_title
        has_tts = bool(os.environ.get("ELEVENLABS_API_KEY", ""))
        has_hf  = bool(os.environ.get("HIGGSFIELD_API_KEY", ""))

        # Detectar URLs en el body para saber si hay source ingestion
        _body_urls = _re.findall(r"https?://[^\s<>\"'\)\]]+", issue_body) if issue_body else []
        _has_src   = len(_body_urls) > 0
        # Agentes base: DS + CA + Story + Prompt = 4
        # Con TTS: +1, con Higgsfield: +Popcorn +Imagen Video +VA = +3
        _total_agents = (1 if _has_src else 0) + 4 + (1 if has_tts else 0) + (3 if has_hf else 0)

        # ── Kickoff message ──────────────────────────────────────
        _phase  = 1
        _phases = ""
        if _has_src:
            _src_types = []
            for _u in _body_urls:
                if "youtube.com" in _u or "youtu.be" in _u:
                    _src_types.append("YouTube")
                elif _u.endswith(".pdf"):
                    _src_types.append("PDF")
                else:
                    _src_types.append("web")
            _src_label = ", ".join(dict.fromkeys(_src_types)) or "web"
            _phases += f"{_phase}️⃣ **Source Reader** — extraigo contenido real de {len(_body_urls)} fuente(s) ({_src_label})\n"
            _phase += 1
        _phases += f"{_phase}️⃣ **Deep Search + Channel Analyzer** — tendencias y competencia (en paralelo)\n"; _phase += 2
        _phases += f"{_phase}️⃣ **Storytelling** — guión {'basado en tus fuentes' if _has_src else 'adaptado al nicho'}\n"; _phase += 1
        if has_tts:
            _phases += f"{_phase}️⃣ **TTS + Prompt Generator** — voz en off y prompts de imagen (en paralelo)\n"; _phase += 2
        else:
            _phases += f"{_phase}️⃣ **Prompt Generator** — prompts de imagen por escena\n"; _phase += 1
        if has_hf:
            _phases += f"{_phase}️⃣ **Imagen Generator** — imágenes coherentes con Higgsfield Popcorn Auto\n"; _phase += 1
            _phases += f"{_phase}️⃣ **Imagen Video** — clips cinematográficos con DoP Turbo First-Last Frame\n"; _phase += 1
        if has_tts and has_hf:
            _phases += f"{_phase}️⃣ **Video Assembler** — MP4 final 9:16 con voz en off\n"; _phase += 1

        _eta = 10 if _has_src and has_tts and has_hf else (8 if has_tts and has_hf else 5)

        _src_tip = (
            f"\n\n📌 **Fuentes detectadas ({len(_body_urls)}):**\n"
            + "\n".join(f"  - `{u[:70]}`" for u in _body_urls[:5])
            + ("\n  - ..." if len(_body_urls) > 5 else "")
        ) if _has_src else (
            "\n\n💡 **Tip:** Pega URLs en la descripción del issue para activar el **Source Reader**"
            " — artículos web, videos de YouTube o PDFs se convierten en la base factual del video."
        )

        post_issue_comment(
            f"🎬 Perfecto, me pongo en marcha con: **{issue_title}**\n\n"
            f"Coordino **{_total_agents} agentes** en secuencia:\n"
            + _phases
            + f"\n⏱️ Listo en ~{_eta} minutos."
            + _src_tip
        )
    elif not objetivo:
        objetivo = "crea contenido viral para TikTok y YouTube en español"

    print(f"📌 Objetivo: {objetivo[:120]}", flush=True)

    # ── DB: registrar inicio del run ──────────────────────────
    _db_video_id = None
    if db_configured():
        _db_video_id = save_video(
            tema        = issue_title or objetivo[:200],
            status      = "generating",
            issue_id    = issue_id,
            director_run = run_id,
        )
        if _db_video_id:
            print(f"  📋 DB: run registrado → {_db_video_id}", flush=True)

    # ── Guardia: salir si el issue ya está cerrado ────────────
    # Previene re-runs de getWakeableParentAfterChildCompletion: cuando todos los
    # sub-issues terminan, Paperclip re-despierta al Director. Si el issue ya está
    # done (el Director ya terminó), salimos inmediatamente.
    if issue_id and "Authorization" in auth_headers:
        _guard = _api_request("GET", f"{api_url}/api/issues/{issue_id}", None, auth_headers)
        if _guard and _guard.get("status") in ("done", "cancelled"):
            print(f"⛔ Issue ya está '{_guard.get('status')}' — saliendo para evitar re-run duplicado", flush=True)
            sys.exit(0)

    # ── Checkout del issue al inicio ─────────────────────────
    # Usar POST /checkout en vez de PATCH directo: esto setea TANTO status=in_progress
    # COMO checkoutRunId=<run_id del JWT>, lo que permite que los comentarios y el
    # PATCH final funcionen sin 409. El PATCH final será in_progress→done, que NO
    # dispara statusChangedFromBacklog → sin re-run extra.
    if issue_id and agent_id and "Authorization" in auth_headers:
        try:
            _api_request(
                "POST",
                f"{api_url}/api/issues/{issue_id}/checkout",
                {
                    "agentId": agent_id,
                    "expectedStatuses": ["backlog", "todo", "in_review", "blocked", "in_progress"],
                },
                auth_headers,
            )
            print("✅ Checkout exitoso — issue en in_progress con runId registrado", flush=True)
        except Exception as _e:
            print(f"⚠️  Checkout falló (continuando de todas formas): {_e}", flush=True)

    # Agentes que históricamente fallan el dispatch de Paperclip y deben correr
    # directo como subprocess para no desperdiciar tiempo en el timeout de 240s.
    # El Director tiene un límite de ~300s en Railway — si TTS espera 240s, muere todo.
    # Estos agentes se crean como sub-issue (visibilidad en inbox) pero se ejecutan localmente.
    # video_prompt_generator e imagen_video salen de SUBPROCESS_ONLY cuando
    # tienen un ID real de Paperclip → corren en su propio proceso Railway.
    # video_assembler pasa a delegado (propio proceso Railway) para no bloquear
    # al Director los ~90s que tarda FFmpeg + upload.
    # popcorn corre siempre como subprocess: es más fiable y Paperclip dispatch
    # no añade valor (el proceso tarda 2-4 min y el timeout de 180s no es suficiente).
    _subprocess_base = {"tts", "source_reader"}
    _maybe_delegated = {"video_prompt_generator", "imagen_video", "video_assembler"}
    SUBPROCESS_ONLY = _subprocess_base | {
        k for k in _maybe_delegated if not SUB_AGENT_IDS.get(k)
    }

    # ── Helper: orquesta un sub-agente vía Paperclip ──────────
    def run_tracked(script: str, task: str, label: str, agent_key: str,
                    extra_env: dict = None, paperclip_timeout: int = 180) -> str:
        """
        Estrategia de orquestación real:
        1. Crea sub-issue con assigneeAgentId + description (tarea) → visible en inbox
        2. Si el agente responde a statusChangedFromBacklog → espera resultado (polling)
        3. Si timeout o SUBPROCESS_ONLY → fallback a subprocess local
        4. Cierra el sub-issue con el resultado
        """
        assignee_id = SUB_AGENT_IDS.get(agent_key, "")

        # Calcular ANTES de crear el sub-issue: los agentes en SUBPROCESS_ONLY
        # NO deben tener assigneeAgentId, porque Paperclip intentaría dispatcharlos
        # por su cuenta (conflicto con el subprocess local que ya lanzamos).
        use_subprocess_directly = agent_key in SUBPROCESS_ONLY or not assignee_id
        _assignee_for_issue = "" if use_subprocess_directly else assignee_id

        sub_id = None

        if issue_id and "Authorization" in auth_headers:
            # Inyectar PARENT_ISSUE_ID en la descripción para los agentes que corren
            # de forma asíncrona (imagen_video, video_assembler). Paperclip les inyecta
            # la descripción como PAPERCLIP_ISSUE_BODY, así el agente puede extraer el
            # ID del issue padre y notificar a Studio cuando termina.
            _async_agents = {"imagen_video", "video_assembler"}
            # Usar texto plano (no HTML <!--...-->) para evitar saneamiento del API
            _desc = (f"PARENT_ISSUE_ID:{issue_id}\n{task}"
                     if agent_key in _async_agents else task)
            sub_id = create_sub_issue(
                title=f"🤖 {label}",
                agent_key=agent_key,
                description=_desc,
                assignee_agent_id=_assignee_for_issue,
                parent_issue_id=issue_id,
                api_url=api_url,
                auth_headers=auth_headers,
                company_id=company_id,
            )

        if sub_id and assignee_id and not use_subprocess_directly:
            # PATCH a 'todo' → statusChangedFromBacklog → Paperclip despacha el sub-agente
            _api_request("PATCH", f"{api_url}/api/issues/{sub_id}", {"status": "todo"}, auth_headers)
            print(f"  🚀 {label} despachado — esperando que Paperclip lo complete...", flush=True)

            result = _wait_for_sub_agent(sub_id, label, api_url, auth_headers,
                                         timeout=paperclip_timeout)
            if result is not None:
                print(f"  ✅ {label} completado vía Paperclip ({len(result)} caracteres)", flush=True)
                return result

            # video_assembler e imagen_video son procesos pesados y asíncronos.
            # No hacer subprocess fallback: causaría que DOS instancias intentaran
            # cerrar el mismo sub-issue → HTTP 409 Conflict.
            # Dejarlos correr en su propio proceso Paperclip; Studio actualiza
            # la UI cuando llega el comentario PC_AGENT_UPDATE al issue padre.
            if agent_key == "video_assembler":
                print(f"  ⏳ Video Assembler en proceso — Director continúa sin esperar", flush=True)
                return f"[video_assembler:en_proceso:sub_id={sub_id}]"

            if agent_key == "imagen_video":
                print(f"  ⏳ Imagen Video en proceso — Director continúa sin esperar", flush=True)
                return f"[imagen_video:en_proceso:sub_id={sub_id}]"

            print(f"  ⚠️  Timeout esperando {label} — usando subprocess como fallback...", flush=True)
            _api_request("PATCH", f"{api_url}/api/issues/{sub_id}", {"status": "in_progress"}, auth_headers)

        elif sub_id:
            # Sub-issue visible pero ejecución local inmediata.
            # No parchear a in_progress: sin assignee → HTTP 422.
            # close_sub_issue marcará como done cuando termine.
            pass

        # ── Subprocess (directo o fallback) ──────────────────
        sub_env = {**os.environ}
        if extra_env:
            sub_env.update(extra_env)
        if sub_id:
            sub_env["PAPERCLIP_ISSUE_ID"] = sub_id
        else:
            sub_env.pop("PAPERCLIP_ISSUE_ID", None)
        sub_env.pop("PAPERCLIP_ISSUE_TITLE", None)
        sub_env.pop("PAPERCLIP_ISSUE_BODY", None)
        # Pasar ID del issue padre para que los sub-agentes puedan notificar Studio directamente
        if issue_id:
            sub_env["PAPERCLIP_PARENT_ISSUE_ID"] = issue_id

        # Video Assembler necesita hasta 270s (ffmpeg por imagen a ultrafast).
        # TTS necesita ~90s (ElevenLabs + upload).
        if agent_key == "video_assembler":
            _subprocess_timeout = 270
        elif agent_key == "imagen_video":
            # 3 clips × ~90s cada uno (2 en paralelo) + margen = 200s
            _subprocess_timeout = 200
        elif agent_key == "popcorn":
            # Popcorn puede tardar 2-4 min dependiendo del num_images
            _subprocess_timeout = 240
        elif agent_key == "tts":
            _subprocess_timeout = 120
        else:
            _subprocess_timeout = 90
        result = run_agent_with_env(script, task, sub_env, label, timeout=_subprocess_timeout)

        # Cerrar el sub-issue con el resultado
        if sub_id:
            if result and not (result.startswith('[') and 'Error' in result):
                close_sub_issue(sub_id, result, api_url, auth_headers)
            else:
                close_sub_issue(sub_id, result or '[Sin resultado]', api_url, auth_headers)

        return result

    import re as _re

    # ── Fase 0: Source Reader (solo si hay URLs en el body) ───
    source_context  = ""
    source_result   = ""
    _urls_in_body   = _re.findall(r"https?://[^\s<>\"'\)\]]+", issue_body) if issue_body else []
    has_sources     = len(_urls_in_body) > 0

    if has_sources:
        _src_count = len(_urls_in_body)
        post_issue_comment(
            f"📚 **Fase 0 — Source Reader** en progreso…\n\n"
            f"Detecté {_src_count} fuente(s) en la descripción. "
            f"Extraigo el contenido real para basar el video en información verificada."
        )
        source_result = run_tracked(
            "source_reader.py", issue_body,
            "Source Reader — Ingesta de fuentes", "source_reader"
        )
        # Extraer la síntesis del JSON de resultado
        try:
            _src_m = _re.search(r'\{[\s\S]*?"synthesis"[\s\S]*?\}', source_result)
            if _src_m:
                _src_data    = json.loads(_src_m.group(0))
                source_context = _src_data.get("synthesis", "")
                # Si el topic extraído es más específico, úsalo
                _src_topic   = _src_data.get("topic", "")
                if _src_topic and len(_src_topic) > 5:
                    objetivo = f"{objetivo} — basado en fuentes: {_src_topic}"
        except Exception:
            source_context = source_result[:2000]
        print(f"📚 Source context: {len(source_context)} chars", flush=True)

    # ── Fase 1: Investigación ──────────────────────────────────
    # Obtener títulos virales reales de YouTube para enriquecer los prompts
    _yt_director_key = os.environ.get("YOUTUBE_API_KEY_DIRECTOR", "")
    _yt_viral_titles = ""
    if _yt_director_key:
        print("🎬 Obteniendo títulos virales reales de YouTube...", flush=True)
        _yt_viral_titles = fetch_yt_viral_titles(objetivo[:100], _yt_director_key)
        if _yt_viral_titles:
            print(f"  ✅ {_yt_viral_titles.count(chr(10))} títulos reales obtenidos", flush=True)

    _yt_hint      = f"\n\n{_yt_viral_titles}" if _yt_viral_titles else ""
    _source_hint  = f"\n\nFUENTES REALES PROCESADAS:\n{source_context[:800]}" if source_context else ""
    search_task   = f"Busca tendencias virales y keywords de oportunidad para el tema: {objetivo}{_source_hint}{_yt_hint}"
    analyzer_task = f"Analiza los canales más exitosos de YouTube y TikTok sobre: {objetivo}. Encuentra sus debilidades.{_source_hint}{_yt_hint}"

    _fase_inv = 2 if has_sources else 1
    post_issue_comment(
        f"🔍📊 **Fases {_fase_inv} y {_fase_inv + 1} — Deep Search + Channel Analyzer** "
        f"corriendo en paralelo…"
    )
    with ThreadPoolExecutor(max_workers=2) as _ex:
        _f_ds = _ex.submit(run_tracked, "deep_search.py", search_task,
                           "Deep Search — Tendencias", "deep_search")
        _f_ca = _ex.submit(run_tracked, "channel_analyzer.py", analyzer_task,
                           "Channel Analyzer — Competencia", "channel_analyzer")
        deep_search_result = _f_ds.result()
        channel_result     = _f_ca.result()

    # ── Fase 2: Guión ─────────────────────────────────────────
    _source_block = ""
    if source_context:
        _source_block = f"\n\nCONTENIDO REAL DE LAS FUENTES (úsalo como base factual del guión):\n{source_context[:1500]}"

    storytelling_task = sanitize(f"""Crea un guion viral con 4-5 escenas para el tema: {objetivo}
{_source_block}

Contexto de tendencias encontradas:
{deep_search_result[:400]}

Diferenciacion vs competencia:
{channel_result[:250]}
{_yt_viral_titles[:300] if _yt_viral_titles else ""}""")

    post_issue_comment("✍️ **Fase 3 — Storytelling** en progreso…")
    storytelling_result = run_tracked("storytelling.py", storytelling_task,
                                      "Storytelling — Guión 4-5 escenas", "storytelling")

    # ── TTS en background — corre en paralelo con Style Decision + PG ──
    # TTS solo necesita el guión → puede arrancar ahora mismo.
    # Esperamos su resultado después de que PG termine.
    tts_result     = ""
    audio_path     = ""
    audio_url_tts  = ""
    narration_text = ""
    elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY", "")
    _tts_executor  = None
    _tts_future    = None
    if elevenlabs_key:
        post_issue_comment(
            "🎙️ **TTS** arrancado en background (corre en paralelo con Prompt Generator)…"
        )
        _tts_executor = ThreadPoolExecutor(max_workers=1)
        _tts_future   = _tts_executor.submit(
            run_tracked, "tts.py", storytelling_result,
            "TTS — Voz en off", "tts",
            {"ELEVENLABS_API_KEY": elevenlabs_key}, 90,
        )
        post_issue_comment("PIPELINE_ACTIVE:tts")
    else:
        print("⚠️  ELEVENLABS_API_KEY no encontrada — saltando TTS", flush=True)

    # ── Fase 3b: Decisión de estilo visual (LLM) ─────────────
    # Basándose en las tendencias (Deep Search) y el guión (Storytelling),
    # el Director elige automáticamente el Soul Style y el DoP Motion
    # más apropiados para el contenido.
    soul_style_choice = ""
    dop_motion_choice = ""

    _style_prompt = """Eres un director de arte de contenido viral en TikTok/YouTube.
Analiza las tendencias detectadas y el guión, y elige las opciones de producción visual óptimas.

DETECCIÓN DE CONTENIDO ANIMADO — MUY IMPORTANTE:
Si el tema involucra personajes de dibujos animados, videojuegos, anime, cartoon o universos ficticios
(ejemplos: Bob Esponja, Sonic, Goku, Pikachu, Mario, Minecraft, Fortnite, Mickey Mouse, etc.):
→ Elige soul_style de la categoría SURREAL/ARTE: Creatures, Artwork, Mixed Media, Duplicate, Giant People, Clouded Dream, 2049
→ NO uses estilos realistas como Realistic, Spotlight, Rainy Day, iPhone, CCTV
→ genre: usa "horror" si es oscuro/creepy, "accion" si hay movimiento, "drama" si es emocional

SOUL STYLES disponibles (elige 1, o deja vacío para base):
Retratos/Makeup: Creatures, Babydoll MakeUp, Glazed doll skin makeup, Paper Face, Object Makeup
Moda/Editorial: Medieval, Spotlight, Quiet luxury, FashionShow, 90's Editorial, Avant-garde, Grunge, Fairycore, Coquette core, Bimbocore, Indie sleaze, Gorpcore, Tumblr
Y2K/Retro: DigitalCam, 2000s Cam, Y2K, 90s Grain, Vintage PhotoBooth, VHS
Cámara/Efecto: Glitch, CCTV, iPhone, Overexposed, Realistic, Fisheye, Datamosh
Escenarios: Subway, Library, Rainy Day, Sunset beach, Night Beach, Amalfi Summer, Gallery, Foggy Morning, Flight mode
Surreal/Arte: Artwork, Mixed Media, Duplicate, Angel Wings, Giant Accessory, Geominimal, Clouded Dream, 2049, Giant People
Lifestyle: Selfcare, Graffiti, Tokyo Streetstyle, Paparazzi, Movie, Sand
General: General, Realistic

DOP MOTIONS disponibles (elige 1, o "auto" para arco narrativo automático):
Cámara: Dolly In, Dolly Out, Dolly Zoom In, Arc Left, Arc Right, Crane Up, Crane Down, Crash Zoom In, Super Dolly In, Whip Pan, FPV Drone, Overhead, Snorricam, Zoom In, Dutch Angle
Efectos: Focus Change, Lens Flare, Paparazzi
Personaje: Catwalk, Levitation, Agent Reveal, Soul Jump, Action Run
General: General, Handheld

GÉNEROS disponibles:
horror, conspiracion, accion, misterio, drama

Responde SOLO con JSON válido (sin explicaciones fuera del JSON):
{
  "soul_style": "nombre exacto del estilo o vacío",
  "dop_motion": "auto",
  "genre": "horror|conspiracion|accion|misterio|drama",
  "razon": "1 línea explicando la elección"
}"""

    _style_user = f"""TENDENCIAS DETECTADAS:
{deep_search_result[:600]}

NICHO/TEMA: {objetivo[:150]}

TONO DEL GUIÓN (primeras líneas):
{storytelling_result[:300]}"""

    try:
        _style_response = call_llm(
            messages=[
                {"role": "system", "content": _style_prompt},
                {"role": "user",   "content": _style_user},
            ],
            api_key=api_key,
            max_tokens=150,
            temperature=0.3,
            title="Director - Decision de estilo visual",
            model="anthropic/claude-3-5-haiku",
            timeout=20,
            retries=1,
        )
        _style_m = _re.search(r'\{[\s\S]*?\}', _style_response)
        if _style_m:
            _style_data   = json.loads(_style_m.group(0))
            soul_style_choice = (_style_data.get("soul_style") or "").strip()
            dop_motion_choice = (_style_data.get("dop_motion") or "").strip()
            genre_choice      = (_style_data.get("genre") or "drama").strip().lower()
            _razon            = _style_data.get("razon", "")
            print(f"🎨 Estilo elegido: soul_style='{soul_style_choice}' | genre='{genre_choice}'", flush=True)
            if _razon:
                print(f"   📝 {_razon}", flush=True)
    except Exception as _se:
        print(f"⚠️  No se pudo elegir estilo automáticamente: {_se}", flush=True)
        genre_choice = "drama"

    # ── Fase 4: Prompt Generator ──────────────────────────────
    # Nuevo rol: genera UN prompt narrativo optimizado para Popcorn Auto
    # usando Perplexity para referencias visuales reales del nicho.
    prompt_task = sanitize(f"""{storytelling_result[:4500]}""")

    post_issue_comment("🎨 **Fase 5 — Prompt Generator** optimizando prompt para Popcorn…")
    prompt_result = run_tracked("prompt_generator.py", prompt_task,
                                "Prompt Generator — Popcorn Optimizer", "prompt_generator")

    # ── Esperar TTS (que corrió en paralelo con Style + PG) ──
    if _tts_future is not None:
        try:
            tts_result = _tts_future.result(timeout=130)
        except Exception as _tts_e:
            print(f"⚠️  TTS error en background: {_tts_e}", flush=True)
        finally:
            if _tts_executor:
                _tts_executor.shutdown(wait=False)
        try:
            _m = _re.search(r'\{[\s\S]*?"audio_(?:path|url)"[\s\S]*?\}', tts_result)
            if _m:
                _tts_data        = json.loads(_m.group(0))
                audio_path       = _tts_data.get("audio_path", "")
                audio_url_tts    = _tts_data.get("audio_url", "")
                narration_text   = _tts_data.get("narration_text", "")
        except Exception:
            pass
        if not audio_path or not os.path.exists(audio_path):
            import glob as _glob
            _mp3s = sorted(_glob.glob("/tmp/narration_*.mp3"), key=os.path.getmtime, reverse=True)
            audio_path = _mp3s[0] if _mp3s else ""
        print(f"🎙️ Audio path: {audio_path or 'no disponible'}", flush=True)
        print(f"🔗 Audio URL TTS: {audio_url_tts[:80] if audio_url_tts else 'no disponible'}", flush=True)

    imagen_result  = "[Imagen Generator: HIGGSFIELD_API_KEY no configurada — omitido]"
    higgsfield_key = os.environ.get("HIGGSFIELD_API_KEY", "")
    if higgsfield_key:
        # Usar Popcorn Auto: genera 5 imágenes visualmente coherentes de una sola llamada.
        # Ventaja sobre Soul: las escenas tienen estética consistente sin tener que
        # coordinar prompts individuales. Popcorn toma la narrativa completa como input.
        post_issue_comment("🍿 **Fase 6 — Imagen Generator (Popcorn Auto)** en progreso… (2-3 min)")

        # Popcorn necesita: AMBIENTE (atmósfera/setting) + GUIÓN (narración).
        # NO usar prompts técnicos de Soul/cámara — Popcorn genera las escenas
        # internamente a partir de la narrativa.
        _ambiente = objetivo[:200]
        if soul_style_choice:
            _ambiente += f". Estilo visual: {soul_style_choice}."
        if dop_motion_choice and dop_motion_choice.lower() != "auto":
            _ambiente += f" Movimiento de cámara: {dop_motion_choice}."

        # Extraer narración del storytelling (texto spoken, no instrucciones de cámara)
        _narr_matches = _re.findall(
            r'(?:NARRACIÓN|voz en off)[^:]*:\s*(.*?)(?=🎬|⚡|━━|ESCENA\s+\d)',
            storytelling_result, _re.DOTALL | _re.IGNORECASE
        )
        if _narr_matches:
            _guion = " | ".join(m.strip()[:300] for m in _narr_matches[:5] if m.strip())
            print(f"  🎨 Guión Popcorn: {len(_narr_matches)} narraciones extraídas", flush=True)
        else:
            _guion = storytelling_result[:800]
            print(f"  🎨 Guión Popcorn: fallback a storytelling completo", flush=True)

        # Preamble positivo y neutro — las listas de palabras "PROHIBIDO" activan
        # el filtro NSFW de Higgsfield incluso cuando el contenido es seguro.
        _copyright_safe = (
            "Cinematic story visuals. Anonymous fictional characters in original settings. "
            "Dramatic atmosphere, artistic composition, photorealistic style.\n\n"
        )

        # Sanitizar el guión: sustituir palabras que activan filtros de contenido
        # por equivalentes visuales neutros, manteniendo el tono dramático.
        _nsfw_map = [
            (r'\b(asesinato|asesinar|asesino|matar|mat[oó]|muerto|cadáver|cuerpo sin vida)\b', 'confrontation'),
            (r'\b(sangre|herida|hemorragia)\b',                            'shadow'),
            (r'\b(violencia|violento|brutal|brutalidad)\b',                'intensity'),
            (r'\b(droga[s]?|narcotraficante|narcotráfico|cartel|cocaína|heroína|fentanilo)\b', 'contraband'),
            (r'\b(pistola|arma[s]?|revólver|fusil|disparar|disparo|bala)\b', 'tension'),
            (r'\b(secuestro|secuestrar|rehén|tortura|torturar)\b',         'crisis'),
            (r'\b(explosión|bomba|detonar|terroris[mt]a?)\b',              'incident'),
        ]
        _guion_safe = _guion
        for _pat, _repl in _nsfw_map:
            _guion_safe = _re.sub(_pat, _repl, _guion_safe, flags=_re.IGNORECASE)

        # ── Usar prompt del Prompt Generator si está disponible ──
        # El Prompt Generator ya corrió en paralelo y puede haber generado
        # un prompt Popcorn optimizado con referencias visuales reales.
        _pg_popcorn = ""
        if prompt_result:
            try:
                _pg_json = None
                _pg_m = _re.search(r'```json\s*([\s\S]+?)```', prompt_result)
                if _pg_m:
                    _pg_json = json.loads(_pg_m.group(1))
                elif prompt_result.strip().startswith("{"):
                    _pg_json = json.loads(prompt_result.strip())
                if _pg_json and _pg_json.get("popcorn_prompt"):
                    _pg_popcorn = _pg_json["popcorn_prompt"].strip()
                    _vs = _pg_json.get("visual_style", "")
                    print(f"  ✅ Usando prompt Popcorn del Prompt Generator ({len(_pg_popcorn)} chars)", flush=True)
                    if _vs:
                        print(f"  🎨 Estilo visual: {_vs[:80]}", flush=True)
            except Exception as _pg_e:
                print(f"  ⚠️  No se pudo extraer popcorn_prompt del PG: {_pg_e}", flush=True)

        if _pg_popcorn:
            # Sanitizar el prompt del PG con el mismo nsfw_map
            _pg_safe = _pg_popcorn
            for _pat, _repl in _nsfw_map:
                _pg_safe = _re.sub(_pat, _repl, _pg_safe, flags=_re.IGNORECASE)
            _visual_brief = (_copyright_safe + _pg_safe)[:2000]
            print(f"  📝 Prompt Popcorn (PG, {len(_visual_brief)} chars): {_visual_brief[:80]}…", flush=True)
        else:
            _visual_brief = (_copyright_safe + f"Visual mood: {_ambiente}\n\nStory visuals:\n{_guion_safe}")[:2000]
            print(f"  📝 Prompt Popcorn (manual, {len(_visual_brief)} chars): {_visual_brief[:80]}…", flush=True)

        # Lote 1: 8 imágenes (máximo por llamada Popcorn)
        _popcorn_task_1 = sanitize(json.dumps({
            "prompt":       _visual_brief,
            "num_images":   8,
            "aspect_ratio": "9:16",
            "resolution":   "720p",
        }, ensure_ascii=False))

        post_issue_comment(
            "🍿 **Fase 5b — Popcorn Auto** lote 1/2 (8 imágenes)…"
        )
        post_issue_comment("PIPELINE_ACTIVE:popcorn")
        _pop_result_1 = run_tracked(
            "popcorn.py", _popcorn_task_1,
            "Imagen Lote 1 — Higgsfield Popcorn Auto", "popcorn",
            paperclip_timeout=300,
        )

        # Extraer primera URL del lote 1 como referencia visual para el lote 2
        _b1_ext  = _re.findall(r"https?://[^\s\"')]+\.(?:png|jpg|jpeg|webp)", _pop_result_1)
        _b1_bold = _re.findall(r"\*\*URL:\*\*\s*(https?://\S+)", _pop_result_1)

        # ── Retry reactivo anti-copyright ────────────────────────
        # Si Popcorn no devolvió imágenes, probablemente el prompt contiene
        # referencias con copyright. Reescribir con LLM y reintentar una vez.
        if not _b1_ext and not _b1_bold:
            print("  ⚠️  Lote 1 sin imágenes — posible bloqueo por copyright. Reescribiendo prompt…", flush=True)
            post_issue_comment("⚠️ Popcorn bloqueado (posible copyright) — reescribiendo prompt y reintentando…")
            try:
                _safe_prompt = call_llm(
                    messages=[
                        {"role": "system", "content": "You rewrite image generation prompts to be safe for content filters. Focus on visual atmosphere, lighting, composition. Replace any violence/crime/drug references with neutral cinematic equivalents. Return ONLY the rewritten prompt."},
                        {"role": "user", "content": f"Rewrite this prompt to avoid content filter triggers. Keep the visual mood and cinematic atmosphere:\n\n{_visual_brief}"},
                    ],
                    api_key=api_key,
                    model="anthropic/claude-3-5-haiku",
                    max_tokens=600,
                    temperature=0.3,
                    title="Director - safe prompt retry",
                    timeout=20,
                    retries=1,
                )
                _visual_brief = _safe_prompt.strip()[:2000]
                print(f"  🔄 Prompt reescrito ({len(_visual_brief)} chars) — reintentando Popcorn…", flush=True)
                _retry_task = sanitize(json.dumps({
                    "prompt":       _visual_brief,
                    "num_images":   8,
                    "aspect_ratio": "9:16",
                    "resolution":   "720p",
                }, ensure_ascii=False))
                _pop_result_1 = run_tracked(
                    "popcorn.py", _retry_task,
                    "Imagen Lote 1 — Popcorn Auto (retry safe)", "popcorn",
                    paperclip_timeout=300,
                )
                _b1_ext  = _re.findall(r"https?://[^\s\"')]+\.(?:png|jpg|jpeg|webp)", _pop_result_1)
                _b1_bold = _re.findall(r"\*\*URL:\*\*\s*(https?://\S+)", _pop_result_1)
            except Exception as _retry_err:
                print(f"  ❌ Retry fallido: {_retry_err}", flush=True)

        _b1_ref  = (_b1_bold or _b1_ext or [None])[0]

        # ── Construir prompt del lote 2 (segundo acto — diferente al lote 1) ──
        # Lote 1 cubre apertura + setup. Lote 2 cubre tensión + clímax + resolución.
        # Esto evita que ambos lotes generen imágenes visualmente repetitivas.
        if _narr_matches and len(_narr_matches) > 2:
            # Tomar la segunda mitad de las narraciones para el segundo acto
            _half   = len(_narr_matches) // 2
            _guion2 = " | ".join(m.strip()[:300] for m in _narr_matches[_half:] if m.strip())
        else:
            # Fallback: usar la segunda mitad del guión completo
            _mid    = len(storytelling_result) // 2
            _guion2 = storytelling_result[_mid:_mid + 800]

        # Sanitizar el guión del segundo acto
        _guion2_safe = _guion2
        for _pat, _repl in _nsfw_map:
            _guion2_safe = _re.sub(_pat, _repl, _guion2_safe, flags=_re.IGNORECASE)

        if _pg_popcorn:
            # Si el PG generó un prompt, crear variante de clímax para el lote 2
            _visual_brief_2 = (_copyright_safe +
                               f"CLIMAX AND RESOLUTION — continuation of the same story. "
                               f"Visual style: {_pg_json.get('visual_style', '') if '_pg_json' in dir() and _pg_json else ''}\n\n"
                               f"{_guion2_safe}")[:2000]
        else:
            _visual_brief_2 = (_copyright_safe +
                               f"Visual mood: {_ambiente} — SECOND ACT: tension, climax, resolution.\n\n"
                               f"Story visuals:\n{_guion2_safe}")[:2000]

        print(f"  📝 Prompt Popcorn lote 2 ({len(_visual_brief_2)} chars): {_visual_brief_2[:80]}…", flush=True)

        # Lote 2: 8 imágenes más con prompt del segundo acto
        _pop_result_2 = ""
        _task_2_data = {
            "prompt":       _visual_brief_2,
            "num_images":   8,
            "aspect_ratio": "9:16",
            "resolution":   "720p",
        }
        if _b1_ref:
            _task_2_data["image_urls"] = [_b1_ref]

        try:
            post_issue_comment("🍿 **Fase 5b — Popcorn Auto** lote 2/2 (8 imágenes más)…")
            _pop_result_2 = run_tracked(
                "popcorn.py", sanitize(json.dumps(_task_2_data, ensure_ascii=False)),
                "Imagen Lote 2 — Higgsfield Popcorn Auto", "popcorn",
                paperclip_timeout=300,
            )
        except Exception as _e2:
            print(f"  ⚠️  Lote 2 Popcorn falló ({_e2}) — continuando con lote 1 solo", flush=True)

        imagen_result = _pop_result_1 + ("\n" + _pop_result_2 if _pop_result_2 else "")
        print(f"  🍿 Popcorn completado — lote 1: {'OK' if _pop_result_1 else '✗'}, lote 2: {'OK' if _pop_result_2 else 'omitido'}", flush=True)
    else:
        print("⚠️  HIGGSFIELD_API_KEY no encontrada — saltando Imagen Generator", flush=True)

    # ── Extraer URLs de imágenes ──────────────────────────────
    _ext_urls  = _re.findall(r"https?://[^\s\"')]+\.(?:png|jpg|jpeg|webp)", imagen_result)
    _bold_urls = _re.findall(r"\*\*URL:\*\*\s*(https?://\S+)", imagen_result)
    _md_urls   = _re.findall(r"\]\((https?://[^\s)]+)\)", imagen_result)
    _img_urls  = list(dict.fromkeys(_ext_urls + _bold_urls + _md_urls))
    print(f"  🖼️  URLs de imágenes detectadas: {len(_img_urls)}", flush=True)
    for _u in _img_urls[:6]:
        print(f"     • {_u[:90]}", flush=True)

    # ═══════════════════════════════════════════════════════════
    # FASE GARANTIZADA — Síntesis + publicar resultado
    # Se ejecuta ANTES de la cadena de video para asegurar que
    # el usuario SIEMPRE recibe el contenido aunque Railway
    # mate el proceso durante la animación/ensamblado.
    # ═══════════════════════════════════════════════════════════

    print(f"\n{'='*60}", flush=True)
    print("🧠 Sintetizando paquete ejecutivo...", flush=True)
    print(f"{'='*60}", flush=True)

    reports = {
        "deep_search":      deep_search_result,
        "channel_analyzer": channel_result,
        "storytelling":     storytelling_result,
        "prompt_generator": prompt_result,
        "imagen":           imagen_result,
    }
    try:
        synthesis = synthesize(objetivo, reports, api_key)
    except Exception as e:
        synthesis = f"[Error en síntesis: {e}]"

    # ── Construir secciones del output ───────────────────────
    _raw_ext   = _re.findall(r"https?://[^\s\"')]+\.(?:png|jpg|jpeg|webp)", imagen_result)
    _raw_bold  = _re.findall(r"\*\*URL:\*\*\s*(https?://\S+)", imagen_result)
    _raw_md    = _re.findall(r"\]\((https?://[^\s)]+)\)", imagen_result)
    imagen_urls = list(dict.fromkeys(_raw_ext + _raw_bold + _raw_md))

    imagen_gallery = ""
    if imagen_urls:
        imagen_gallery = "\n## 🖼️ IMÁGENES GENERADAS\n"
        for i, url in enumerate(imagen_urls, 1):
            imagen_gallery += f"![Imagen {i}]({url})\n"
        imagen_gallery += "\n"

    source_section = ""
    if source_result:
        try:
            _sd = json.loads(_re.search(r'\{[\s\S]*?\}', source_result).group(0))
            _src_urls = _sd.get("sources", [])
            if _src_urls:
                source_section = "\n## 📚 FUENTES UTILIZADAS\n"
                for _su in _src_urls:
                    source_section += f"- {_su}\n"
                source_section += "\n"
        except Exception:
            pass

    tts_section = ""
    if tts_result:
        try:
            _tts_match = _re.search(r'\{[\s\S]*?"audio_url"[\s\S]*?\}', tts_result)
            if _tts_match:
                _tts = json.loads(_tts_match.group(0))
                if _tts.get("audio_url"):
                    tts_section = f"\n## 🎙️ VOZ EN OFF\n📥 [Descargar MP3]({_tts['audio_url']}) — {_tts.get('duration_estimate','')}\n\n"
        except Exception:
            pass

    # Video en proceso — la cadena de video corre después de publicar
    video_section = ""
    if higgsfield_key and elevenlabs_key and _img_urls:
        video_section = (
            "\n## 🎬 VIDEO EN PROCESO\n"
            "⏳ Los agentes **Video Prompt Generator → Imagen Video → Video Assembler** "
            "están animando y ensamblando el MP4 ahora mismo. "
            "El link de descarga aparecerá en el sub-issue **Video Assembler — MP4 final** "
            "en ~3-5 minutos.\n\n"
        )

    output = f"""# 🎬 PAQUETE COMPLETO DE CONTENIDO
**Tema:** {objetivo}
**Generado por:** Director de Contenido ({(1 if has_sources else 0) + (7 if elevenlabs_key and higgsfield_key else 5)} agentes coordinados)
{source_section}{video_section}{tts_section}{imagen_gallery}
{synthesis}

---

## 📎 REPORTES DETALLADOS

<details>
<summary>🔍 Deep Search - Tendencias completas</summary>

{deep_search_result[:3000]}
</details>

<details>
<summary>🔭 Channel Analyzer - Análisis competencia</summary>

{channel_result[:2000]}
</details>

<details>
<summary>✨ Storytelling - Guión completo (4-5 escenas)</summary>

{storytelling_result[:3500]}
</details>

<details>
<summary>🪄 Prompt Generator - Prompts de imágenes (5-6)</summary>

{prompt_result[:3500]}
</details>

<details>
<summary>🖼️ Imagen Generator - Imágenes generadas con Higgsfield Soul</summary>

{imagen_result[:3000]}
</details>
{("<details><summary>🎙️ TTS - Audio narración</summary>" + chr(10) + tts_result[-2000:] + chr(10) + "</details>") if tts_result else ""}
{("<details><summary>📚 Source Reader - Fuentes procesadas</summary>" + chr(10) + source_result[-2000:] + chr(10) + "</details>") if source_result else ""}
"""
    print(output, flush=True)

    # ── Publicar resultado y cerrar issue ANTES de la cadena de video ──
    if issue_id and "Authorization" in auth_headers:
        _api_request("POST", f"{api_url}/api/issues/{issue_id}/comments",
                     {"body": output}, auth_headers)
        print("✅ Resultado publicado en el inbox", flush=True)
        _api_request("PATCH", f"{api_url}/api/issues/{issue_id}",
                     {"status": "done"}, auth_headers)
        print("✅ Issue principal cerrado — iniciando cadena de video best-effort", flush=True)
    elif issue_id:
        print("⚠️  Sin auth — issue no se pudo cerrar", flush=True)

    # ═══════════════════════════════════════════════════════════
    # CADENA DE VIDEO — Best-effort
    # El issue ya está cerrado y el resultado publicado.
    # Si Railway mata el proceso aquí, el usuario ya tiene
    # guión + imágenes + audio. El video es un bonus.
    # ═══════════════════════════════════════════════════════════

    # ── Fase 6b: Imagen Video — DoP Lite First-Last Frame ────
    # DoP Lite (2 cr/clip): toma pares de imágenes consecutivas
    # (img0→img1, img1→img2 …) y genera un clip cinematográfico por par.
    # Con 2 lotes Popcorn × 8 imágenes → hasta 16 imágenes → 15 clips.
    # Ya NO necesitamos Video Prompt Generator — DoP interpreta las transiciones solo.

    # Extraer duración objetivo del storytelling (ej. "70 segundos", "Duración: 60s")
    _dur_target = 0
    _dur_m = _re.search(
        r'[Dd]urac[ií][oó]n[^:\d]*[:\-]?\s*[^\d]*(\d{2,3})\s*s(?:eg(?:undos?)?)?',
        storytelling_result
    )
    if _dur_m:
        _dur_target = int(_dur_m.group(1))
        print(f"  ⏱️  Duración objetivo extraída del storytelling: {_dur_target}s", flush=True)
    else:
        print(f"  ⏱️  Duración objetivo no detectada — imagen_video usará 5s/clip por defecto", flush=True)

    imagen_video_result = ""
    if higgsfield_key and _img_urls and len(_img_urls) >= 2:
        # IMPORTANTE: no incluir image_urls ni narration_text largo aquí —
        # el description del sub-issue tiene límite de 4000 chars y el JSON
        # se trunca, rompiendo la extracción de image_urls en imagen_video.
        # image_urls las pasa imagen_video al assembler directamente.
        _asm_params = {
            "audio_path":     audio_path,
            "audio_url":      audio_url_tts,
            "tema":           objetivo[:100],
            "narration_text": narration_text[:300] if narration_text else "",
        }
        # Construir tarea: ASSEMBLER_PARAMS primero + JSON con image_urls para el agente
        # El Director NO pasa dop_motion — imagen_video usa su arco narrativo
        # automático (motions variados según posición del clip).
        # El LLM elige soul_style para las imágenes pero los motions los
        # gestiona imagen_video internamente para máxima variedad cinemática.
        # Extraer contextos de escena del storytelling para motion LLM
        _scene_ctxs = _re.findall(
            r'(?:ESCENA\s+\d+[^:\n]*|##\s*🎬[^\n]*|###\s*Escena\s*\d+[^\n]*)[:\n]+([^\n]{20,200})',
            storytelling_result, _re.IGNORECASE
        )
        _scene_ctxs = [s.strip() for s in _scene_ctxs[:15] if s.strip()]
        if not _scene_ctxs:
            # Fallback: tomar las primeras líneas de cada narración
            _narr_lines = _re.findall(r'(?:NARRACIÓN|VOZ EN OFF)[^:]*:\s*([^\n]{20,150})', storytelling_result, _re.IGNORECASE)
            _scene_ctxs = _narr_lines[:15]
        print(f"  🎬 Contextos de escena extraídos: {len(_scene_ctxs)}", flush=True)

        _iv_json: dict = {
            "image_urls":    _img_urls,
            "source":        "popcorn_auto",
            "genre":         genre_choice,
            "scene_contexts": _scene_ctxs,
        }
        if _dur_target > 0:
            _iv_json["target_duration"] = _dur_target
        _iv_input = json.dumps(_iv_json, ensure_ascii=False)
        _iv_task = (
            f"ASSEMBLER_PARAMS:{json.dumps(_asm_params, ensure_ascii=False)}\n\n"
            + _iv_input
        )
        _motion_label = " · arco narrativo automático"
        post_issue_comment(
            f"🎞️ **Fase 6b — Imagen Video (DoP Lite)** en proceso…\n"
            f"Generando {len(_img_urls) - 1} clips de transición entre las {len(_img_urls)} escenas"
            f"{_motion_label}. Puede tardar 5-15 min."
        )
        post_issue_comment("PIPELINE_ACTIVE:imagen_video")
        imagen_video_result = run_tracked(
            "imagen_video.py", sanitize(_iv_task),
            "Imagen Video — Higgsfield DoP Lite", "imagen_video",
            extra_env={"HIGGSFIELD_API_KEY": higgsfield_key},
            paperclip_timeout=0,
        )
        print(f"  ⏳ Imagen Video ({len(_img_urls)-1} clips) + Video Assembler en proceso", flush=True)
    elif higgsfield_key and _img_urls:
        print(f"  ⚠️  Solo {len(_img_urls)} imagen(es) — se necesitan ≥2 para First-Last Frame", flush=True)

    # ── Fase 7: Video Assembler ──────────────────────────────
    # Caso normal: lo lanza Imagen Video internamente con los clips reales.
    # Caso fallback: sin Higgsfield pero con ElevenLabs → video con fotos fijas.
    if elevenlabs_key and not higgsfield_key and _img_urls:
        video_task = sanitize(json.dumps({
            "video_clips": [],
            "image_urls":  _img_urls,
            "audio_path":  audio_path,
            "audio_url":   audio_url_tts,
            "tema":        objetivo[:100],
        }, ensure_ascii=False))
        print("  🎬 Despachando Video Assembler (fotos+audio, sin Higgsfield)", flush=True)
        run_tracked("video_assembler.py", video_task,
                    "Video Assembler — MP4 final", "video_assembler",
                    paperclip_timeout=0)

    # ── DB: actualizar video con resultados finales ──────────────
    if _db_video_id and db_configured():
        import re as _re3
        _ht = _re3.findall(r'#\w+', storytelling_result)[:10]
        _dur = _dur_target if '_dur_target' in dir() and _dur_target else None
        update_video(
            video_id     = _db_video_id,
            guion        = storytelling_result[:8000],
            audio_url    = audio_url_tts or "",
            image_urls   = _img_urls if '_img_urls' in dir() else [],
            hashtags     = _ht,
            duration_sec = _dur,
            status       = "generated",
        )
        print(f"  ✅ DB: video actualizado → {_db_video_id}", flush=True)

    # ── Fase 8: TikTok Publisher (opcional) ─────────────────────
    # Solo si TIKTOK_ACCESS_TOKEN está configurado y AUTO_PUBLISH_TIKTOK=true
    tiktok_token      = os.environ.get("TIKTOK_ACCESS_TOKEN", "").strip()
    auto_publish_tt   = os.environ.get("AUTO_PUBLISH_TIKTOK", "false").lower() == "true"
    if tiktok_token and auto_publish_tt and audio_url_tts:
        # Extraer hashtags del storytelling (palabras con #)
        import re as _re2
        _hashtags = _re2.findall(r'#\w+', storytelling_result)[:8] or ["#viral", "#fyp", "#español"]
        _tt_task  = json.dumps({
            "video_url":  audio_url_tts,  # URL del video final (cuando esté disponible)
            "tema":       objetivo[:80],
            "hashtags":   _hashtags,
            "caption":    f"{objetivo[:150]}\n",
        }, ensure_ascii=False)
        post_issue_comment("📱 **Fase 8 — TikTok Publisher** publicando automáticamente...")
        run_tracked(
            "tiktok_publisher.py", _tt_task,
            "TikTok Publisher — Auto-publicación", "tiktok_publisher",
            extra_env={
                "TIKTOK_CLIENT_KEY":    os.environ.get("TIKTOK_CLIENT_KEY", ""),
                "TIKTOK_CLIENT_SECRET": os.environ.get("TIKTOK_CLIENT_SECRET", ""),
                "TIKTOK_ACCESS_TOKEN":  tiktok_token,
                "TIKTOK_REFRESH_TOKEN": os.environ.get("TIKTOK_REFRESH_TOKEN", ""),
                "TIKTOK_PRIVACY":       os.environ.get("TIKTOK_PRIVACY", "SELF_ONLY"),
            },
            paperclip_timeout=120,
        )


if __name__ == "__main__":
    main()
