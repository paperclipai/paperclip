"""
Agente: Source Reader (Lector de Fuentes)
Ingesta fuentes externas: URLs web, YouTube, PDFs.
Extrae el contenido real y lo estructura para alimentar el pipeline de contenido.

Uso: añade URLs en la descripción del issue — el Director lo ejecuta automáticamente.
Soporta: artículos web, videos de YouTube (transcripción), PDFs online.

Output JSON:
{
  "sources_found": N,
  "sources": [...urls],
  "source_types": [...tipos],
  "content_raw": "...",
  "synthesis": "...",
  "topic": "..."
}
"""
import os
import sys
import re
import json
import urllib.request
import urllib.parse
import urllib.error
import html
from html.parser import HTMLParser

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from api_client import call_llm, post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


# ── HTML Cleaner ─────────────────────────────────────────────────────────────

class TextExtractor(HTMLParser):
    """Extrae texto limpio de HTML, ignorando scripts/styles/nav."""
    IGNORE_TAGS = {"script", "style", "nav", "footer", "head", "noscript",
                   "iframe", "aside", "header", "form", "button", "svg", "path"}
    BLOCK_TAGS  = {"p", "h1", "h2", "h3", "h4", "h5", "li", "br", "div",
                   "article", "section", "blockquote", "tr", "td", "th"}

    def __init__(self):
        super().__init__()
        self.text_parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.IGNORE_TAGS:
            self._skip_depth += 1
        elif tag in self.BLOCK_TAGS:
            self.text_parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.IGNORE_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)

    def handle_data(self, data):
        if self._skip_depth == 0:
            text = data.strip()
            if text:
                self.text_parts.append(text + " ")

    def get_text(self) -> str:
        raw = "".join(self.text_parts)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        raw = re.sub(r"[ \t]{2,}", " ", raw)
        return raw.strip()


# ── Web Scraper ───────────────────────────────────────────────────────────────

def scrape_web_page(url: str) -> str:
    """Descarga y extrae texto limpio de una página web."""
    print(f"  🌐 Scrapeando: {url[:80]}", flush=True)
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=20) as r:
            content_type = r.headers.get("Content-Type", "")
            raw = r.read()

        # Encoding
        encoding = "utf-8"
        if "charset=" in content_type:
            enc_candidate = content_type.split("charset=")[-1].strip().split(";")[0]
            if enc_candidate:
                encoding = enc_candidate

        text_html = raw.decode(encoding, errors="replace")

        # Título
        title_m = re.search(r"<title[^>]*>(.*?)</title>", text_html, re.IGNORECASE | re.DOTALL)
        title = html.unescape(title_m.group(1).strip()) if title_m else ""

        # Meta description
        desc_m = re.search(
            r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)',
            text_html, re.IGNORECASE
        )
        description = html.unescape(desc_m.group(1).strip()) if desc_m else ""

        # Texto
        parser = TextExtractor()
        parser.feed(text_html)
        body_text = parser.get_text()

        result = f"**Fuente:** {url}\n**Título:** {title}\n"
        if description:
            result += f"**Descripción:** {description}\n"
        result += f"\n{body_text[:7000]}"

        print(f"  ✅ Web scrapeada: {len(body_text)} chars extraídos", flush=True)
        return result

    except Exception as e:
        print(f"  ⚠️  Error scrapeando {url[:60]}: {e}", flush=True)
        return f"[Error al acceder a {url}: {e}]"


# ── YouTube Transcript ────────────────────────────────────────────────────────

def extract_video_id(url: str) -> str:
    """Extrae el video ID de cualquier formato de URL de YouTube."""
    patterns = [
        r"[?&]v=([a-zA-Z0-9_-]{11})",
        r"youtu\.be/([a-zA-Z0-9_-]{11})",
        r"/embed/([a-zA-Z0-9_-]{11})",
        r"/shorts/([a-zA-Z0-9_-]{11})",
    ]
    for pattern in patterns:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    return ""


def get_youtube_transcript(video_id: str) -> str:
    """Obtiene transcripción de YouTube vía timedtext API (sin deps externos)."""
    print(f"  📺 Obteniendo transcripción YouTube: {video_id}", flush=True)
    title = f"Video {video_id}"

    try:
        # 1. Descargar página para extraer título y captionTracks
        watch_url = f"https://www.youtube.com/watch?v={video_id}"
        req = urllib.request.Request(watch_url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=20) as r:
            page_html = r.read().decode("utf-8", errors="replace")

        # Título
        title_m = re.search(r'"title":\{"runs":\[\{"text":"([^"]+)"', page_html)
        if not title_m:
            title_m = re.search(r'<title>([^<]+)</title>', page_html)
        if title_m:
            title = html.unescape(title_m.group(1).replace(" - YouTube", "").strip())

        # 2. Buscar captionTracks en el JSON embebido
        caption_m = re.search(r'"captionTracks":(\[.*?\])', page_html, re.DOTALL)
        if caption_m:
            try:
                tracks = json.loads(caption_m.group(1))
                base_url = ""
                # Preferencia: español → inglés → cualquiera
                for lang_pref in ["es", "en", ""]:
                    for track in tracks:
                        lang = track.get("languageCode", "")
                        if not lang_pref or lang.startswith(lang_pref):
                            base_url = track.get("baseUrl", "")
                            break
                    if base_url:
                        break

                if base_url:
                    transcript_url = base_url + "&fmt=json3"
                    with urllib.request.urlopen(transcript_url, timeout=15) as r:
                        td = json.loads(r.read().decode("utf-8"))
                    texts = [
                        seg.get("utf8", "").strip()
                        for event in td.get("events", [])
                        for seg in event.get("segs", [])
                        if seg.get("utf8", "").strip() not in ("", "\n")
                    ]
                    transcript = re.sub(r"\s+", " ", " ".join(texts)).strip()
                    if transcript:
                        result = (
                            f"**Fuente:** https://youtube.com/watch?v={video_id}\n"
                            f"**Título:** {title}\n"
                            f"**Tipo:** Transcripción de video YouTube\n\n"
                            f"{transcript[:8000]}"
                        )
                        print(f"  ✅ Transcripción obtenida: {len(transcript)} chars", flush=True)
                        return result
            except Exception as e:
                print(f"  ⚠️  Error parseando captionTracks: {e}", flush=True)

        # 3. Fallback: timedtext API directo
        for lang in ["es", "es-419", "en"]:
            try:
                turl = f"https://www.youtube.com/api/timedtext?lang={lang}&v={video_id}&fmt=json3"
                with urllib.request.urlopen(turl, timeout=10) as r:
                    data = json.loads(r.read().decode("utf-8"))
                texts = [
                    seg.get("utf8", "").strip()
                    for event in data.get("events", [])
                    for seg in event.get("segs", [])
                    if seg.get("utf8", "").strip()
                ]
                if texts:
                    transcript = re.sub(r"\s+", " ", " ".join(texts)).strip()
                    print(f"  ✅ Timedtext API ({lang}): {len(transcript)} chars", flush=True)
                    return (
                        f"**Fuente:** https://youtube.com/watch?v={video_id}\n"
                        f"**Título:** {title}\n\n{transcript[:8000]}"
                    )
            except Exception:
                continue

        # Sin transcripción disponible
        print(f"  ⚠️  Sin transcripción — devolviendo título/URL", flush=True)
        return (
            f"**Fuente:** https://youtube.com/watch?v={video_id}\n"
            f"**Título:** {title}\n\n"
            f"[Transcripción no disponible — el video puede no tener subtítulos. "
            f"Se usará el título como referencia principal.]"
        )

    except Exception as e:
        print(f"  ⚠️  Error YouTube {video_id}: {e}", flush=True)
        return f"[Error al acceder al video de YouTube {video_id}: {e}]"


# ── PDF Extraction ────────────────────────────────────────────────────────────

def extract_pdf_text(url: str) -> str:
    """Descarga y extrae texto de un PDF (método básico sin deps externos)."""
    print(f"  📄 Procesando PDF: {url[:80]}", flush=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            pdf_data = r.read()

        # Extracción de texto de bloques BT...ET (sin PyPDF2)
        decoded = pdf_data.decode("latin-1", errors="replace")
        bt_blocks = re.findall(r"BT(.*?)ET", decoded, re.DOTALL)
        text_parts = []
        for block in bt_blocks:
            # Strings entre paréntesis (texto literal en PDF)
            strings = re.findall(r"\(([^)\\]{1,200})\)", block)
            for s in strings:
                cleaned = re.sub(r"[^\x20-\x7e\xc0-\xff]", " ", s).strip()
                if len(cleaned) > 3:
                    text_parts.append(cleaned)

        if text_parts:
            text = " ".join(text_parts)
            text = re.sub(r"\s+", " ", text).strip()
            print(f"  ✅ PDF procesado: {len(text)} chars", flush=True)
            return f"**Fuente:** {url}\n**Tipo:** PDF\n\n{text[:8000]}"
        else:
            print(f"  ⚠️  PDF sin texto extraíble (puede ser imagen-only)", flush=True)
            return f"**Fuente PDF:** {url}\n[PDF procesado pero sin texto extraíble — posiblemente es un PDF de imágenes]"

    except Exception as e:
        print(f"  ⚠️  Error PDF {url[:60]}: {e}", flush=True)
        return f"[Error al procesar PDF {url}: {e}]"


# ── Source Detection ──────────────────────────────────────────────────────────

def detect_source_type(url: str) -> str:
    """Clasifica el tipo de fuente por URL."""
    u = url.lower()
    if "youtube.com/watch" in u or "youtu.be/" in u or "youtube.com/shorts/" in u:
        return "youtube"
    if u.endswith(".pdf") or "/pdf/" in u or "type=pdf" in u:
        return "pdf"
    return "web"


def find_sources(text: str) -> list:
    """Encuentra todas las URLs en el texto y las clasifica."""
    urls = re.findall(r"https?://[^\s<>\"'\)\]\}]+", text)
    sources = []
    seen = set()
    for url in urls:
        url = url.rstrip(".,;:!?)")  # limpiar puntuación trailing
        if url not in seen:
            seen.add(url)
            sources.append({"url": url, "type": detect_source_type(url)})
    return sources


# ── LLM Synthesis ─────────────────────────────────────────────────────────────

SYNTHESIS_PROMPT = """Eres un experto en análisis de contenido para creación de videos virales en español.
Recibes contenido extraído de fuentes reales (artículos web, transcripciones de YouTube, PDFs).

Analiza el contenido y estructura un brief completo para producir un video viral:

## 📌 RESUMEN DE FUENTES
[2-3 párrafos con los puntos más importantes y reveladores del contenido]

## 🔥 DATOS Y HECHOS CLAVE
[Los 5-10 datos, cifras, revelaciones o hechos más impactantes — son el core del video]

## 👥 PROTAGONISTAS Y CONTEXTO
[Personas, marcas, entidades relevantes: quiénes son, qué hicieron, por qué importa]

## 🎬 ÁNGULO VIRAL SUGERIDO
[Cómo contar esta historia para generar impacto: hook inicial, tensión, revelación final]

## 🏷️ KEYWORDS Y HASHTAGS
[Palabras clave relevantes y hashtags para maximizar alcance en este tema]

Usa SOLO información real de las fuentes. No inventes datos ni cifras."""


def synthesize_sources(contents: list, topic: str, api_key: str) -> str:
    """Usa LLM para sintetizar y estructurar el contenido de todas las fuentes."""
    combined = "\n\n" + ("─" * 40) + "\n\n".join(contents)
    combined_truncated = combined[:12000]

    user_msg = f"Tema/contexto: {topic}\n\nContenido extraído de las fuentes:\n\n{combined_truncated}"

    try:
        result = call_llm(
            messages=[
                {"role": "system", "content": SYNTHESIS_PROMPT},
                {"role": "user", "content": user_msg}
            ],
            api_key=api_key,
            max_tokens=1500,
            temperature=0.3,
            title="Paperclip - Source Reader Synthesis",
            model="perplexity/sonar",  # acceso a internet para verificar hechos
        )
        print(f"  ✅ Síntesis completada ({len(result)} chars)", flush=True)
        return result
    except Exception as e:
        print(f"  ⚠️  Perplexity falló: {e} — usando modelo base", flush=True)
        try:
            return call_llm(
                messages=[
                    {"role": "system", "content": SYNTHESIS_PROMPT},
                    {"role": "user", "content": user_msg}
                ],
                api_key=api_key,
                max_tokens=1500,
                temperature=0.3,
                title="Paperclip - Source Reader Synthesis",
            )
        except Exception as e2:
            return f"[Error en síntesis: {e2}]\n\nContenido bruto:\n{combined_truncated[:3000]}"


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) > 1:
        raw_input = " ".join(sys.argv[1:])
    else:
        raw_input = sys.stdin.read().strip()

    issue_title, issue_body = resolve_issue_context()
    if issue_body:
        raw_input = issue_body

    topic = issue_title or "contenido del video"

    # Detectar fuentes en el input
    sources = find_sources(raw_input)
    print(f"🔍 {len(sources)} fuentes detectadas", flush=True)
    for s in sources:
        print(f"   [{s['type'].upper()}] {s['url'][:70]}", flush=True)

    post_issue_comment(
        f"📚 **Leyendo {len(sources)} fuente(s)...**\n\n"
        + "\n".join(f"- [{s['type'].upper()}] `{s['url'][:60]}`" for s in sources)
        + "\n\nExtrayendo contenido real para alimentar el pipeline."
    )

    if not sources:
        # Sin URLs — usar el texto directamente
        print("ℹ️  Sin URLs — usando texto como fuente directa", flush=True)
        result_data = {
            "sources_found": 0,
            "sources": [],
            "source_types": [],
            "content_raw": raw_input[:6000],
            "synthesis": raw_input[:3000],
            "topic": topic,
        }
        print(json.dumps(result_data, ensure_ascii=False, indent=2))
        post_issue_result("📚 Sin URLs detectadas — se usa el texto de la descripción como fuente.")
        return

    # Extraer contenido de cada fuente
    contents = []
    source_summary = []
    for src in sources:
        url = src["url"]
        src_type = src["type"]

        if src_type == "youtube":
            video_id = extract_video_id(url)
            content = get_youtube_transcript(video_id) if video_id else scrape_web_page(url)
        elif src_type == "pdf":
            content = extract_pdf_text(url)
        else:
            content = scrape_web_page(url)

        contents.append(content)
        source_summary.append(f"- [{src_type.upper()}] {url[:70]}")

    print(f"\n✅ {len(contents)} fuentes procesadas — sintetizando con LLM...", flush=True)

    # Síntesis estructurada
    synthesis = synthesize_sources(contents, topic, api_key)

    # Output final
    result_data = {
        "sources_found": len(sources),
        "sources": [s["url"] for s in sources],
        "source_types": [s["type"] for s in sources],
        "content_raw": ("\n\n" + "─" * 40 + "\n\n").join(contents)[:8000],
        "synthesis": synthesis,
        "topic": topic,
    }

    result_json = json.dumps(result_data, ensure_ascii=False, indent=2)
    print(result_json)

    post_issue_result(
        f"📚 **{len(sources)} fuente(s) procesada(s)**\n\n"
        + "\n".join(source_summary)
        + f"\n\n---\n\n{synthesis[:1000]}...\n\n"
        + "_Contenido inyectado en el pipeline de producción_ 🚀"
    )


if __name__ == "__main__":
    main()
