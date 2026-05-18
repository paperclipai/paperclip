"""
Asistente de Proyectos - Toby & Diskontrol
Recibe contexto de Paperclip via stdin/env y responde usando OpenRouter.
"""
import os
import sys
import json
import urllib.request
import urllib.error

# Fix Windows encoding para emojis
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

SYSTEM_PROMPT = """Eres el asistente personal de Alejandro para sus proyectos de IA.

## Proyecto Toby
IA personal tipo Jarvis, nombrada en honor al perro fallecido de Alejandro.
Personalidad del perro Toby: inteligente, curioso, juguetón, travieso por dentro, fiel y protector.
- Stack: Python en Desktop/Toby/, usa OpenRouter (claude-haiku)
- Fase 2 COMPLETADA: 5 emociones que evolucionan, memoria corto/largo plazo/episódica, búsqueda web, CLI (/nuevo, /nota, /recuerdos, /salir, /ayuda)
- Fase 3 PENDIENTE: voz con Whisper + ElevenLabs
- Fase 4 PENDIENTE: visión con screenshot + análisis
- Fase 5 PENDIENTE: integración con Diskontrol

## Proyecto Diskontrol
Agencia de IA bootstrap que ayuda negocios físicos a modernizarse con IA.
- Stack productivo: Voiceflow/Botpress (prototipos), Make.com, n8n, Supabase, Claude API, ElevenLabs
- Regla de negocio: prototipo gratuito → cliente paga 50% antes de producción
- Artefactos listos: Barbería (citas WhatsApp), Panadería (pedidos WhatsApp + demo.html), Inmobiliaria (calificador leads), Demo-citas (genérico reutilizable)
- Repo: C:/Users/Alejandro/Diskontrol/ (GitHub: alejandrojesusperezblanco4-commits/diskontrol)
- Web: index.html con Formspree listo, PENDIENTE publicar en Netlify

## Cómo responder
- Siempre en español
- Directo y práctico, sin relleno
- Conoces el historial completo, no preguntes lo que ya sabes
- Propón siguientes pasos concretos cuando sea útil
"""

def call_openrouter(task: str, api_key: str) -> str:
    payload = {
        "model": "deepseek/deepseek-chat-v3-0324",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": task}
        ],
        "max_tokens": 800
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://127.0.0.1:3100",
            "X-Title": "Paperclip - Asistente Proyectos"
        },
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=60) as response:
        result = json.loads(response.read().decode("utf-8"))
        return result["choices"][0]["message"]["content"]


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    # Leer tarea desde stdin o args
    if len(sys.argv) > 1:
        task = " ".join(sys.argv[1:])
    else:
        task = sys.stdin.read().strip()

    # Contexto extra de Paperclip si está disponible
    issue_title = os.environ.get("PAPERCLIP_ISSUE_TITLE", "")
    issue_body = os.environ.get("PAPERCLIP_ISSUE_BODY", "")
    if issue_title:
        task = f"Tarea: {issue_title}\n\n{issue_body or task}"

    if not task:
        task = "Dame un resumen del estado actual de los proyectos Toby y Diskontrol con los próximos pasos recomendados."

    try:
        response = call_openrouter(task, api_key)
        print(response)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"ERROR HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
