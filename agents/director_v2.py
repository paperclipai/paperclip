"""
Director v2 — Orquestador unificado
Un solo LLM call que reemplaza los 4 sub-agentes.
Sin subprocesos, sin dependencias, sin fallos en cadena.
"""
import os
import sys
import json
import hmac
import hashlib
import base64
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

FREE_MODELS = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-3-27b-it:free",
    "openai/gpt-oss-120b:free",
    "mistralai/mistral-7b-instruct:free",
]

SYSTEM_PROMPT = """Eres el Director de Contenido IA para el canal TikTok @historias.en.sombra, especializado en historias de terror y misterio basadas en Reddit, en español.

Cuando recibas un objetivo, debes entregar UN PAQUETE COMPLETO DE CONTENIDO actuando como 4 especialistas al mismo tiempo:

---

# 🎬 PAQUETE DE CONTENIDO — @historias.en.sombra

## 1. 🔍 TENDENCIAS Y KEYWORDS (Deep Search)
- Top 5 temas virales de terror/misterio en TikTok ahora mismo
- Hashtags con mayor crecimiento: #NoSleep #RedditHorror #Terror etc.
- Subreddits más activos: r/nosleep, r/UnresolvedMysteries, r/creepyencounters
- 3 historias de Reddit con alto potencial viral esta semana (con título y resumen)

## 2. 🔭 ANÁLISIS DE COMPETENCIA (Channel Analyzer)
- Canales similares en TikTok/YouTube en español y sus debilidades
- Qué formatos funcionan (narración en voz, texto animado, imágenes IA)
- Oportunidades que no están aprovechando

## 3. 🎙️ GUIÓN COMPLETO (Storytelling Designer)
Basado en la mejor historia encontrada, crea el guión listo para grabar:

### Hook (primeros 3 segundos) — 3 variantes:
- Hook A: ...
- Hook B: ...
- Hook C: ...

### Guión completo (60-90 segundos para TikTok):
[Narración palabra por palabra, tono oscuro y suspense]

### CTA final:
[Llamada a la acción]

## 4. 🖼️ PROMPTS DE IMÁGENES (Prompt Generator)
Genera prompts listos para usar en Midjourney/DALL-E para el thumbnail/cover:

```json
{
  "midjourney": "prompt en inglés --ar 9:16 --v 6",
  "dalle3": "prompt detallado para DALL-E 3",
  "style": "dark, horror, cinematic, TikTok vertical"
}
```

## 5. 📅 PLAN DE LA SEMANA
| Día | Historia | Plataforma | Hora sugerida |
|-----|----------|------------|---------------|
[3-5 posts para la semana]

## 6. ⚡ ACCIONES INMEDIATAS
1. [Acción concreta hoy]
2. [Acción concreta mañana]
3. [Acción para esta semana]

---

IMPORTANTE: Sé específico, usa nombres reales de historias de Reddit, hashtags reales, y escribe el guión completo palabra por palabra en español. Tono: oscuro, suspense, cinematográfico."""


def call_llm(objetivo: str, api_key: str) -> str:
    """Llama al LLM con retry y fallback de modelos."""
    import time

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Crea el paquete de contenido completo para esta semana. Objetivo: {objetivo}"}
    ]

    last_error = None
    for model in FREE_MODELS:
        print(f"🤖 Intentando con modelo: {model}...", flush=True)
        try:
            payload = {
                "model": model,
                "messages": messages,
                "max_tokens": 3000,
                "temperature": 0.75,
            }
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                OPENROUTER_URL,
                data=data,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost:7777",
                    "X-Title": "Paperclip - Director v2",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as response:
                raw = response.read().decode("utf-8")

            try:
                result = json.loads(raw)
            except json.JSONDecodeError:
                print(f"⚠️  Respuesta no-JSON de {model}: {raw[:200]}", flush=True)
                last_error = Exception(f"JSON inválido de {model}")
                continue

            if "error" in result:
                err = result["error"]
                msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                code = err.get("code", 0) if isinstance(err, dict) else 0
                print(f"⚠️  Error API {code} de {model}: {msg[:150]}", flush=True)
                if code in (429, "429") or "rate" in str(msg).lower():
                    print("⏳ Rate limit, esperando 8s...", flush=True)
                    time.sleep(8)
                last_error = Exception(msg)
                continue

            choices = result.get("choices", [])
            if not choices:
                print(f"⚠️  Sin choices de {model}", flush=True)
                last_error = Exception("Sin choices")
                continue

            content = choices[0]["message"]["content"]
            if not content or len(content) < 100:
                print(f"⚠️  Respuesta muy corta de {model} ({len(content)} chars)", flush=True)
                last_error = Exception("Respuesta vacía")
                continue

            print(f"✅ Respuesta recibida de {model} ({len(content)} caracteres)", flush=True)
            return content

        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:200]
            print(f"⚠️  HTTP {e.code} de {model}: {body}", flush=True)
            if e.code == 429:
                time.sleep(8)
            last_error = Exception(f"HTTP {e.code}")
            continue
        except Exception as e:
            print(f"⚠️  Error con {model}: {e}", flush=True)
            last_error = e
            time.sleep(2)
            continue

    raise last_error or Exception("Todos los modelos fallaron")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def create_agent_jwt(agent_id: str, company_id: str, run_id: str, secret: str) -> str:
    header  = json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":"))
    now     = int(time.time())
    payload = json.dumps({
        "sub":          agent_id,
        "company_id":   company_id,
        "adapter_type": "process",
        "run_id":       run_id,
        "iat":          now,
        "exp":          now + 172800,
        "iss":          "paperclip",
        "aud":          "paperclip-api",
    }, separators=(",", ":"))
    signing_input = f"{b64url(header.encode())}.{b64url(payload.encode())}"
    sig = hmac.new(secret.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(sig)}"


def post_comment_and_close(api_url: str, issue_id: str, body: str) -> None:
    """Publica el resultado como comentario en el inbox y cierra el issue."""
    agent_id   = os.environ.get("PAPERCLIP_AGENT_ID", "")
    company_id = os.environ.get("PAPERCLIP_COMPANY_ID", "")
    jwt_secret = (
        os.environ.get("PAPERCLIP_AGENT_JWT_SECRET")
        or os.environ.get("BETTER_AUTH_SECRET", "")
    )
    run_id = os.environ.get("PAPERCLIP_RUN_ID", "director-v2-run")

    headers: dict = {"Content-Type": "application/json"}
    if jwt_secret and agent_id:
        try:
            token = create_agent_jwt(agent_id, company_id, run_id, jwt_secret)
            headers["Authorization"] = f"Bearer {token}"
            print("🔑 JWT generado", flush=True)
        except Exception as e:
            print(f"⚠️  JWT error: {e}", flush=True)

    # 1. Cerrar el issue PRIMERO (así el ownership check no valida run_id al postear)
    try:
        data = json.dumps({"status": "done"}).encode("utf-8")
        req = urllib.request.Request(
            f"{api_url}/api/issues/{issue_id}",
            data=data,
            headers=headers,
            method="PATCH",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f"✅ Issue cerrado (HTTP {r.status})", flush=True)
    except Exception as e:
        print(f"⚠️  No se pudo cerrar el issue: {e}", flush=True)

    # 2. Comentario → aparece en el chat/inbox del issue
    try:
        data = json.dumps({"body": body}).encode("utf-8")
        req = urllib.request.Request(
            f"{api_url}/api/issues/{issue_id}/comments",
            data=data,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            print(f"✅ Resultado publicado en el inbox (HTTP {r.status})", flush=True)
    except Exception as e:
        print(f"⚠️  No se pudo publicar el comentario: {e}", flush=True)


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    # Leer objetivo
    issue_title = os.environ.get("PAPERCLIP_ISSUE_TITLE", "")
    issue_body  = os.environ.get("PAPERCLIP_ISSUE_BODY", "")

    if issue_title:
        objetivo = f"{issue_title}\n{issue_body or ''}".strip()
    elif len(sys.argv) > 1:
        objetivo = " ".join(sys.argv[1:])
    else:
        objetivo = sys.stdin.read().strip()

    if not objetivo:
        objetivo = "historias de terror y misterio de Reddit para TikTok en español — canal @historias.en.sombra"

    print("🎯 DIRECTOR v2 — Orquestador Unificado", flush=True)
    print(f"📌 Objetivo: {objetivo[:120]}", flush=True)
    print("", flush=True)

    try:
        resultado = call_llm(objetivo, api_key)
    except Exception as e:
        print(f"\n❌ ERROR FATAL: {e}", flush=True)
        sys.exit(1)

    print("\n" + "="*60, flush=True)
    print(resultado, flush=True)

    # Publicar en inbox y cerrar issue
    issue_id = os.environ.get("PAPERCLIP_ISSUE_ID", "")
    api_url   = os.environ.get("PAPERCLIP_API_URL", "http://localhost:7777")
    if issue_id:
        post_comment_and_close(api_url, issue_id, resultado)


if __name__ == "__main__":
    main()
