"""
Módulo compartido: cliente de OpenRouter con retry y fallback de modelos.
También incluye post_issue_result() para que los sub-agentes cierren su issue en Paperclip.
"""
import os
import json
import time
import hmac
import hashlib
import base64
import urllib.request
import urllib.error

# Modelos paid — baratos y rápidos. Fallback cascada.
# Costos aproximados (input/output por 1M tokens):
#   gemini-2.0-flash-001 ........ $0.10 / $0.40   (el más barato y rápido)
#   gpt-4o-mini ................. $0.15 / $0.60
#   claude-haiku-4-5 ............ $1.00 / $5.00   (mejor calidad, síntesis)
FREE_MODELS = [
    "google/gemini-2.0-flash-001",
    "openai/gpt-4o-mini",
    "anthropic/claude-3-5-haiku",
]

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def call_llm(
    messages: list,
    api_key: str,
    max_tokens: int = 1500,
    temperature: float = 0.7,
    title: str = "Paperclip Agent",
    timeout: int = 60,
    retries: int = 1,
    model: str = None,
) -> str:
    """
    Llama a OpenRouter con retry automático y fallback de modelos.
    Si se pasa `model`, lo usa como primera opción antes de la cascada.
    Devuelve el texto generado o lanza Exception con el error detallado.
    """
    last_error = None
    models_to_try = [model] + FREE_MODELS if model else FREE_MODELS

    for attempt, model_name in enumerate(models_to_try):
        if attempt >= retries + 1:
            break
        model = model_name  # compat con el resto de la función
        try:
            payload = {
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                OPENROUTER_URL,
                data=data,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://127.0.0.1:7777",
                    "X-Title": title.encode("ascii", errors="replace").decode("ascii"),
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read().decode("utf-8")

            try:
                result = json.loads(raw)
            except json.JSONDecodeError as e:
                raise Exception(f"Respuesta no es JSON ({e}): {raw[:300]}")

            # Verificar errores dentro del JSON
            if "error" in result:
                err = result["error"]
                code = err.get("code", "") if isinstance(err, dict) else str(err)
                msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                # Rate limit → esperar y reintentar
                if code in (429, "429") or "rate" in str(msg).lower():
                    print(f"⚠️  Rate limit en {model}, esperando 10s...", flush=True)
                    time.sleep(10)
                    last_error = Exception(f"Rate limit: {msg}")
                    continue
                raise Exception(f"Error API ({code}): {msg}")

            choices = result.get("choices", [])
            if not choices:
                raise Exception(f"Sin choices en respuesta: {raw[:300]}")

            return choices[0]["message"]["content"]

        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            last_error = Exception(f"HTTP {e.code} en {model}: {body}")
            if e.code == 429:
                print(f"⚠️  Rate limit HTTP en {model}, esperando 10s...", flush=True)
                time.sleep(10)
                continue
            # Para otros errores HTTP, prueba siguiente modelo
            print(f"⚠️  HTTP {e.code} con {model}, probando siguiente modelo...", flush=True)
            continue

        except Exception as e:
            last_error = e
            print(f"⚠️  Error con {model}: {e} — probando siguiente modelo...", flush=True)
            time.sleep(3)
            continue

    raise last_error or Exception("Todos los modelos fallaron")


# ── Paperclip issue posting ───────────────────────────────────────────────────

def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _make_jwt(agent_id: str, company_id: str, run_id: str, secret: str) -> str:
    hdr = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":"))
    now = int(time.time())
    pay = json.dumps({
        "sub": agent_id, "company_id": company_id, "adapter_type": "process",
        "run_id": run_id, "iat": now, "exp": now + 172800,
        "iss": "paperclip", "aud": "paperclip-api",
    }, separators=(",", ":"))
    si  = f"{_b64u(hdr.encode())}.{_b64u(pay.encode())}"
    sig = hmac.new(secret.encode("utf-8"), si.encode("utf-8"), hashlib.sha256).digest()
    return f"{si}.{_b64u(sig)}"


def resolve_issue_context() -> tuple:
    """Devuelve (title, description) del issue actual.
    workspace-runtime.ts solo inyecta PAPERCLIP_ISSUE_TITLE, no PAPERCLIP_ISSUE_BODY.
    Si el body está vacío, hace GET del issue para leer su description."""
    title = os.environ.get("PAPERCLIP_ISSUE_TITLE", "").strip()
    body  = os.environ.get("PAPERCLIP_ISSUE_BODY", "").strip()
    if body:
        return title, body

    issue_id = os.environ.get("PAPERCLIP_ISSUE_ID", "").strip()
    api_url  = os.environ.get("PAPERCLIP_API_URL", "http://localhost:7777").strip()
    if not issue_id:
        return title, body

    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("PAPERCLIP_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    else:
        agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "")
        company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
        run_id     = os.environ.get("PAPERCLIP_RUN_ID", "agent-run")
        secret     = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or
                      os.environ.get("BETTER_AUTH_SECRET", "")).strip()
        if secret and agent_id:
            try:
                token = _make_jwt(agent_id, company_id, run_id, secret)
                headers["Authorization"] = f"Bearer {token}"
            except Exception:
                pass

    try:
        req = urllib.request.Request(f"{api_url}/api/issues/{issue_id}",
                                     headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
            return (data.get("title") or title).strip(), (data.get("description") or "").strip()
    except Exception:
        return title, body


def post_issue_comment(message: str) -> None:
    """Publica un comentario en el issue actual (para confirmaciones, sugerencias, etc.)."""
    issue_id = os.environ.get("PAPERCLIP_ISSUE_ID", "").strip()
    api_url  = os.environ.get("PAPERCLIP_API_URL", "http://localhost:7777").strip()
    if not issue_id:
        return

    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("PAPERCLIP_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    else:
        agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "")
        company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
        run_id     = os.environ.get("PAPERCLIP_RUN_ID", "agent-run")
        secret     = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or
                      os.environ.get("BETTER_AUTH_SECRET", "")).strip()
        if secret and agent_id:
            try:
                token = _make_jwt(agent_id, company_id, run_id, secret)
                headers["Authorization"] = f"Bearer {token}"
            except Exception:
                pass

    data = json.dumps({"body": message}).encode("utf-8")
    req  = urllib.request.Request(
        f"{api_url}/api/issues/{issue_id}/comments",
        data=data, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10): pass
    except Exception:
        pass


def post_parent_update(agent_name: str, output: str) -> None:
    """Publica actualización al issue PADRE cuando un sub-agente termina de forma asíncrona.
    Esto permite que Studio muestre los resultados de Imagen Video y Video Assembler
    aunque el Director ya haya cerrado su issue.
    Usa un marcador especial que Studio detecta al hacer polling de comentarios."""
    parent_id = os.environ.get("PAPERCLIP_PARENT_ISSUE_ID", "").strip()
    api_url   = os.environ.get("PAPERCLIP_API_URL", "http://localhost:7777").strip()
    if not parent_id or not api_url:
        return

    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("PAPERCLIP_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    else:
        agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "")
        company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
        run_id     = os.environ.get("PAPERCLIP_RUN_ID", "agent-run")
        secret     = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or
                      os.environ.get("BETTER_AUTH_SECRET", "")).strip()
        if secret and agent_id:
            try:
                token = _make_jwt(agent_id, company_id, run_id, secret)
                headers["Authorization"] = f"Bearer {token}"
            except Exception:
                pass

    # Marcador especial que Studio detecta al hacer polling.
    # NO usar sintaxis HTML (<!--...-->) porque algunos APIs la sanean al almacenar/devolver.
    # Formato de texto plano: AGENT_UPDATE_START:{nombre}: seguido del output.
    marker = f"AGENT_UPDATE_START:{agent_name}:\n{output[:9500]}"
    data = json.dumps({"body": marker}).encode("utf-8")
    req  = urllib.request.Request(
        f"{api_url}/api/issues/{parent_id}/comments",
        data=data, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15): pass
        print(f"✅ Studio notificado → issue padre {parent_id} ({agent_name})",
              file=__import__("sys").stderr, flush=True)
    except Exception as e:
        print(f"⚠️  No se pudo notificar al issue padre: {e}",
              file=__import__("sys").stderr, flush=True)


def fetch_skill(skill_name: str, company_id: str = "", file_path: str = "SKILL.md") -> str:
    """
    Fetches a skill's SKILL.md content from the Paperclip API at runtime.
    Use this at agent startup to inject skill knowledge into LLM prompts.

    Args:
        skill_name: name of the skill as shown in Paperclip UI (e.g. "ads-copywriter")
        company_id: override company ID (defaults to PAPERCLIP_COMPANY_ID env var)
        file_path:  file to fetch inside the skill (default: SKILL.md)

    Returns:
        Skill content as string, or "" if not found / error.

    Usage in agent:
        skill = fetch_skill("ads-copywriter")
        prompt = f"...{skill}..."
    """
    api_url    = os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100").strip().rstrip("/")
    company_id = company_id or os.environ.get("PAPERCLIP_COMPANY_ID", "").strip()
    agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "").strip()
    run_id     = os.environ.get("PAPERCLIP_RUN_ID", "skill-fetch").strip()
    secret     = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or
                  os.environ.get("BETTER_AUTH_SECRET", "")).strip()

    if not company_id or not api_url:
        return ""

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    api_key = os.environ.get("PAPERCLIP_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    elif secret and agent_id:
        try:
            token = _make_jwt(agent_id, company_id, run_id, secret)
            headers["Authorization"] = f"Bearer {token}"
        except Exception:
            return ""

    def _get(url: str):
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    try:
        # 1. Listar skills de la empresa para encontrar el ID por nombre
        skills = _get(f"{api_url}/api/companies/{company_id}/skills")
        skill_id = None
        for s in (skills if isinstance(skills, list) else skills.get("skills", [])):
            key = s.get("key", "") or s.get("name", "") or s.get("id", "")
            if skill_name.lower() in key.lower():
                skill_id = s.get("id", "")
                break

        if not skill_id:
            print(f"  ⚠️  Skill '{skill_name}' no encontrada en la empresa", flush=True)
            return ""

        # 2. Fetch el archivo de la skill
        import urllib.parse as _up
        encoded_path = _up.quote(file_path, safe="")
        result = _get(f"{api_url}/api/companies/{company_id}/skills/{skill_id}/files?path={encoded_path}")

        content = result if isinstance(result, str) else result.get("content", "")
        if content:
            print(f"  ✅ Skill '{skill_name}' cargada ({len(content)} chars)", flush=True)
        return content or ""

    except Exception as e:
        print(f"  ⚠️  fetch_skill('{skill_name}'): {e}", flush=True)
        return ""


def post_issue_result(output: str) -> None:
    """Cierra el issue de Paperclip y publica el output como comentario.
    Lee las variables de entorno que Paperclip inyecta automáticamente.
    No hace nada si PAPERCLIP_ISSUE_ID no está definido."""
    issue_id   = os.environ.get("PAPERCLIP_ISSUE_ID", "").strip()
    api_url    = os.environ.get("PAPERCLIP_API_URL", "http://localhost:7777").strip()
    if not issue_id:
        return

    headers = {"Content-Type": "application/json"}

    api_key = os.environ.get("PAPERCLIP_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    else:
        agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "")
        company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
        run_id     = os.environ.get("PAPERCLIP_RUN_ID", "agent-run")
        secret     = (os.environ.get("PAPERCLIP_AGENT_JWT_SECRET") or
                      os.environ.get("BETTER_AUTH_SECRET", "")).strip()
        if secret and agent_id:
            try:
                token = _make_jwt(agent_id, company_id, run_id, secret)
                headers["Authorization"] = f"Bearer {token}"
            except Exception:
                pass

    def _call(method, path, body=None):
        data = json.dumps(body).encode("utf-8") if body else None
        req  = urllib.request.Request(f"{api_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status
        except Exception as e:
            print(f"⚠️  Paperclip API {method} {path}: {e}", flush=True)
            return None

    # 1. Publicar resultado como comentario PRIMERO (el frontend detecta 'done' y ya necesita el comentario)
    _call("POST",  f"/api/issues/{issue_id}/comments", {"body": output[:20000]})
    # 2. Marcar done DESPUÉS
    _call("PATCH", f"/api/issues/{issue_id}", {"status": "done"})
    print(f"✅ Resultado publicado en issue {issue_id}", file=__import__("sys").stderr, flush=True)
