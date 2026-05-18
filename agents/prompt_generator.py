"""
Agente: Prompt Generator — Optimizador de Popcorn
Nuevo rol (Opción B): recibe el guión del Storytelling y genera UN
prompt narrativo optimizado para Higgsfield Popcorn Auto.

Flujo:
  1. Detecta si el input es un guión (storytelling) o un brief manual
  2. Busca referencias visuales reales con Perplexity (estilo, paleta, atmósfera)
  3. Genera UN prompt narrativo cinematográfico de ~400-600 palabras
     optimizado para que Popcorn cree 8 imágenes visualmente coherentes

Output JSON:
{
  "popcorn_prompt": "...",     ← el prompt principal para Popcorn
  "visual_style":  "...",     ← estilo visual dominante
  "color_palette": "...",     ← paleta de colores
  "scene_prompts": [...]      ← prompts individuales (legacy, para uso standalone)
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


# ── Detección de modo ─────────────────────────────────────────────────────────

STORYTELLING_MARKERS = [
    "🎙", "NARRACIÓN", "VOZ EN OFF", "ESCENA", "## ESCENA",
    "HOOK", "## 🎬", "guión", "GUIÓN",
]

def is_storytelling_input(text: str) -> bool:
    """Detecta si el input es un guión del Storytelling."""
    return any(m.lower() in text.lower() for m in STORYTELLING_MARKERS)


# ── Búsqueda de referencias visuales ─────────────────────────────────────────

VISUAL_SEARCH_PROMPT = """Eres un experto en referencias visuales para generación de imágenes con IA.
Dado un guión o tema, extrae las referencias visuales EXACTAS y verificadas.

Devuelve SOLO esto:

## ESTILO VISUAL DOMINANTE
- Referencia de película/serie más cercana al tono
- Tipo de iluminación dominante
- Textura visual (hiperrealista, cinemático, grano de película, etc.)

## PALETA DE COLORES
- 3-4 colores dominantes (nombre exacto o hex)
- Contraste general (alto/medio/bajo)

## ATMÓSFERA
- Hora del día / condiciones de luz
- Emoción visual dominante
- Elementos de entorno que refuerzan el tono

## PERSONAJES / FIGURAS
- Si hay personajes: descripción física concreta (anónimos, sin nombres reales)
- Ropa y accesorios clave
- Lenguaje corporal dominante en el guión

Sé específico. Solo datos reales y concretos.
"""

def search_visual_references(topic: str, api_key: str) -> str:
    """Busca referencias visuales reales usando Perplexity."""
    try:
        result = call_llm(
            messages=[
                {"role": "system", "content": VISUAL_SEARCH_PROMPT},
                {"role": "user",   "content": f"Extrae referencias visuales para este guión/tema:\n\n{topic[:800]}"}
            ],
            api_key     = api_key,
            max_tokens  = 600,
            temperature = 0.3,
            title       = "Paperclip - Visual Reference Search",
            model       = "perplexity/sonar",
        )
        print(f"  🔎 Referencias visuales: {len(result)} chars", flush=True)
        return result
    except Exception as e:
        print(f"  ⚠️  Referencias visuales fallaron: {e}", flush=True)
        return ""


# ── Generador de prompt Popcorn ───────────────────────────────────────────────

POPCORN_PROMPT_SYSTEM = """Eres el mejor prompt engineer para Higgsfield Popcorn Auto.
Popcorn recibe UN solo prompt narrativo y genera 8 imágenes visualmente coherentes.

Tu trabajo: convertir un guión en el prompt narrativo perfecto para Popcorn.

DETECCIÓN CRÍTICA — CONTENIDO ANIMADO:
Si el guión menciona personajes de dibujos animados, videojuegos, anime o universos ficticios
(Bob Esponja, Sonic, Goku, Mario, Pikachu, Minecraft, etc.):
→ Empieza con: "3D cinematic dark reimagining of [universe], surreal uncanny atmosphere..."
→ Describe los personajes con sus rasgos distintivos pero en versión oscura/cinemática
→ Usa: "exaggerated proportions, unsettling realism, dramatic cinematic lighting"
→ NO uses "cartoon style" ni "2D animation" — Popcorn genera 3D fotorrealista

REGLAS CRÍTICAS para Popcorn:
1. El prompt es UNA narrativa continua, no una lista de escenas
2. Define el estilo visual AL INICIO — Popcorn lo aplica a todas las imágenes
3. Los personajes deben ser ANÓNIMOS o descritos físicamente (no nombres propios reales)
4. Evita filtros de contenido: usa tensión, confrontación, misterio en vez de violencia explícita
5. El prompt ideal tiene 300-500 palabras en inglés
6. Empieza con el estilo: "Cinematic [género] story..." o "3D dark reimagining of..."

ESTRUCTURA:
[Estilo visual + paleta] → [Personajes con descripción física] →
[Arco narrativo 3-4 frases] → [Atmósfera + emoción] → [Specs técnicas]
"""

def generate_popcorn_prompt(script: str, visual_refs: str, api_key: str) -> dict:
    """Genera el prompt optimizado para Popcorn a partir del guión."""
    user_content = f"""REFERENCIAS VISUALES REALES:
{visual_refs}

---

GUIÓN (para extraer la historia visual):
{script[:3000]}

---

Genera el prompt narrativo optimizado para Popcorn Auto.
Devuelve SOLO JSON válido sin markdown:
{{
  "popcorn_prompt": "el prompt en inglés, 300-500 palabras",
  "visual_style": "estilo visual en 1 línea",
  "color_palette": "paleta en 1 línea"
}}"""

    response = call_llm(
        messages=[
            {"role": "system", "content": POPCORN_PROMPT_SYSTEM},
            {"role": "user",   "content": user_content},
        ],
        api_key     = api_key,
        max_tokens  = 1000,
        temperature = 0.7,
        title       = "Paperclip - Popcorn Prompt Generator",
        model       = "anthropic/claude-sonnet-4-5",
    )

    # Limpiar markdown
    clean = response.strip()
    if "```json" in clean:
        clean = clean.split("```json")[1].split("```")[0].strip()
    elif "```" in clean:
        clean = clean.split("```")[1].split("```")[0].strip()

    try:
        return json.loads(clean)
    except Exception:
        # Fallback: extraer el prompt del texto si el JSON falla
        m = re.search(r'"popcorn_prompt"\s*:\s*"([\s\S]+?)"(?:,|\})', clean)
        if m:
            return {"popcorn_prompt": m.group(1), "visual_style": "", "color_palette": ""}
        return {"popcorn_prompt": clean[:600], "visual_style": "", "color_palette": ""}


# ── Generador de scene_prompts (legacy / standalone) ─────────────────────────

SCENE_PROMPTS_SYSTEM = """Eres el prompt engineer más preciso para Higgsfield Soul (text-to-image, 9:16 vertical).
Transforma cada escena de un guión en un prompt de imagen que cuenta esa parte de la historia.

Devuelve SOLO este JSON (sin markdown):
{
  "scene_prompts": [
    {
      "scene": 1,
      "title": "nombre corto",
      "aspect_ratio": "9:16",
      "resolution": "720p",
      "prompt": "ENGLISH. Character description + action + emotion in body language + camera angle + lighting + background + technical specs. Min 80 words."
    }
  ]
}"""

def generate_scene_prompts(task: str, visual_refs: str, api_key: str) -> str:
    user_content = f"REFERENCIAS VISUALES:\n{visual_refs}\n\n---\n\nGUIÓN/TAREA:\n{task}" if visual_refs else task
    response = call_llm(
        messages=[
            {"role": "system", "content": SCENE_PROMPTS_SYSTEM},
            {"role": "user",   "content": user_content},
        ],
        api_key     = api_key,
        max_tokens  = 3000,
        temperature = 0.75,
        title       = "Paperclip - Scene Prompt Generator",
    )
    clean = response.strip()
    if "```json" in clean:
        clean = clean.split("```json")[1].split("```")[0].strip()
    elif "```" in clean:
        clean = clean.split("```")[1].split("```")[0].strip()
    try:
        parsed = json.loads(clean)
        return json.dumps(parsed, indent=2, ensure_ascii=False)
    except Exception:
        return clean


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) > 1:
        task = " ".join(sys.argv[1:])
    else:
        task = sys.stdin.read().strip()

    issue_title, issue_body = resolve_issue_context()
    if issue_title:
        task = issue_body if issue_body and len(issue_body) > len(issue_title) else issue_title

    if not task:
        task = "Genera prompts para un video de misterio cinematográfico"

    # Detectar modo
    mode = "popcorn" if is_storytelling_input(task) else "scene_prompts"
    print(f"🎨 Prompt Generator — modo: {'Popcorn Optimizer' if mode == 'popcorn' else 'Scene Prompts'}", flush=True)

    if issue_title:
        post_issue_comment(
            f"🎨 Generando {'prompt Popcorn optimizado' if mode == 'popcorn' else 'prompts de escena'} para: **{issue_title[:60]}**\n\n"
            f"Buscando referencias visuales reales..."
        )

    memory_ctx = get_context_summary("prompts", task)
    if memory_ctx:
        task = f"{task}\n\n---\n{memory_ctx}"

    # Buscar referencias visuales
    print("🔎 Buscando referencias visuales...", flush=True)
    visual_refs = search_visual_references(task[:500], api_key)

    try:
        if mode == "popcorn":
            # Modo principal: prompt optimizado para Popcorn
            print("🍿 Generando prompt Popcorn optimizado...", flush=True)
            result = generate_popcorn_prompt(task, visual_refs, api_key)
            output = json.dumps(result, indent=2, ensure_ascii=False)
            save("prompts", task[:60], output)
            print(f"✅ Popcorn prompt: {len(result.get('popcorn_prompt',''))} chars", flush=True)
            print(output, flush=True)
            post_issue_result(output)
        else:
            # Modo legacy: scene_prompts individuales
            print("🎨 Generando scene prompts...", flush=True)
            response = generate_scene_prompts(task, visual_refs, api_key)
            save("prompts", task[:60], response)
            print(response, flush=True)
            post_issue_result(response)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
