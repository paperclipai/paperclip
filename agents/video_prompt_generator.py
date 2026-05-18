"""
Agente: Video Prompt Generator
Dado el guión + las URLs de imágenes ya generadas con Higgsfield Soul,
produce un prompt de movimiento de cámara para cada imagen,
listo para enviarse a Higgsfield DOP (image-to-video).

Output JSON:
{
  "video_prompts": [
    {
      "scene": 1,
      "image_url": "https://...",
      "motion_prompt": "slow push-in on character face, dramatic rim light intensifies..."
    },
    ...
  ]
}
"""
import os
import sys
import json
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from memory import get_context_summary, save
from api_client import call_llm, post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

SYSTEM_PROMPT = """Eres un director de fotografía de cine especializado en crear motion prompts para Higgsfield DOP (image-to-video AI).

Tu trabajo: dado un guión y las imágenes ya generadas para cada escena, describir el MOVIMIENTO DE CÁMARA y la ANIMACIÓN que debe ocurrir en cada imagen para convertirla en un clip de video de 4-6 segundos.

## REGLAS PARA UN MOTION PROMPT GANADOR:

**Movimiento de cámara** (elige uno por escena, el que mejor sirva la narrativa):
- `slow push in` — la cámara avanza lentamente hacia el sujeto (tensión, intimidad)
- `slow pull back` — la cámara retrocede revelando más contexto (revelación, soledad)
- `subtle orbit left/right` — la cámara rota suavemente alrededor del sujeto (poder, drama)
- `slow pan left/right` — panorámica lenta (seguir un movimiento, explorar espacio)
- `gentle tilt up/down` — inclinación (revelar algo, grandiosidad)
- `static with breathing` — casi estático pero con microtemblores de vida (intimidad extrema)
- `drone rise` — la cámara sube lentamente (epicidad, escala)

**Animación del sujeto** (siempre incluir):
- Cabello moviéndose suavemente con el viento
- Ropa con movimiento sutil
- Partículas de ambiente (polvo, humo, lluvia, chispas, hojas)
- Cambio sutil de iluminación (nubes pasando, luz parpadeando)
- Expresión facial que se intensifica

**Ambiente** (si aplica):
- Árboles o vegetación moviéndose
- Agua fluyendo
- Nubes desplazándose en el cielo
- Humo o vapor ambiente

## RESTRICCIONES:
- Máximo 50 palabras por prompt
- Solo en INGLÉS
- NO describir lo que ya está en la imagen estática (eso ya está)
- SOLO describir lo que se MUEVE o CAMBIA durante los segundos de video
- Adaptar el movimiento a la emoción de la escena (tensión = push-in lento, revelación = pull-back, etc.)

## DEVUELVES SOLO este JSON (sin markdown, sin texto extra):

{
  "video_prompts": [
    {
      "scene": 1,
      "image_url": "URL de la imagen de la escena 1",
      "motion_prompt": "slow push-in toward the character, hair gently swaying in breeze, rim light subtly intensifies, dust particles float in air"
    }
  ]
}
"""


def generate_motion_prompts(image_urls: list, storytelling: str, api_key: str) -> str:
    """Llama al LLM para generar motion prompts para cada imagen."""
    user_content = f"""Tienes {len(image_urls)} imágenes generadas para este guión. Genera un motion prompt de movimiento de cámara para cada una.

## GUIÓN (para contexto emocional):
{storytelling[:2000]}

## IMÁGENES GENERADAS (en orden de escena):
{chr(10).join(f'Escena {i+1}: {url}' for i, url in enumerate(image_urls))}

Genera exactamente {len(image_urls)} motion prompts, uno por escena, adaptando el movimiento de cámara a la emoción de cada escena."""

    content = call_llm(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
        ],
        api_key=api_key,
        max_tokens=1500,
        temperature=0.7,
        title="Paperclip - Video Prompt Generator",
    )

    # Limpiar markdown si el modelo lo incluye
    if "```json" in content:
        content = content.split("```json")[1].split("```")[0].strip()
    elif "```" in content:
        content = content.split("```")[1].split("```")[0].strip()

    try:
        parsed = json.loads(content)
        return json.dumps(parsed, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        return content


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    else:
        raw = sys.stdin.read().strip()

    issue_title, issue_body = resolve_issue_context()
    if issue_title:
        raw = issue_body if issue_body else raw
        post_issue_comment(
            f"🎬 Generando motion prompts para animar las imágenes de: **{issue_title}**\n\n"
            f"Analizo cada escena y diseño el movimiento de cámara óptimo para Higgsfield DOP."
        )

    if not raw:
        print("ERROR: Sin input", file=sys.stderr)
        sys.exit(1)

    # Extraer URLs de imágenes del input (viene del imagen_result del director)
    ext_urls  = re.findall(r"https?://[^\s\"')]+\.(?:png|jpg|jpeg|webp)", raw)
    bold_urls = re.findall(r"\*\*URL:\*\*\s*(https?://\S+)", raw)
    md_urls   = re.findall(r"\]\((https?://[^\s)]+)\)", raw)
    image_urls = list(dict.fromkeys(ext_urls + bold_urls + md_urls))

    # Extraer storytelling si viene en el input (separado por ---)
    storytelling = ""
    if "---" in raw:
        parts = raw.split("---", 1)
        storytelling = parts[0].strip()
        url_section  = parts[1].strip()
        # Re-extraer URLs de la sección de URLs si el split las separó
        if not image_urls:
            image_urls = re.findall(r"https?://\S+", url_section)
    else:
        storytelling = raw[:1500]

    if not image_urls:
        print("ERROR: No se encontraron URLs de imágenes en el input", file=sys.stderr)
        sys.exit(1)

    print(f"🎬 Generando motion prompts para {len(image_urls)} imágenes...", flush=True)
    for i, url in enumerate(image_urls):
        print(f"   Escena {i+1}: {url[:80]}", flush=True)

    result = generate_motion_prompts(image_urls, storytelling, api_key)
    print(result, flush=True)
    save("video_prompts", raw[:60], result)
    post_issue_result(result)


if __name__ == "__main__":
    main()
