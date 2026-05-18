"""
Agente: Channel Analyzer
Analiza canales de YouTube del nicho con DATOS REALES via YouTube Data API v3.
Extrae estrategia, frecuencia, formatos y puntos débiles replicables.
"""
import os
import sys
import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from memory import get_context_summary, save, append_channel
from api_client import call_llm, post_issue_result, post_issue_comment, resolve_issue_context
from tiktok_trends import build_tiktok_trends_context
from tiktok_research import build_channel_context as tt_channel_context
from db_client import save_channel, is_configured as db_configured

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

YT_API_BASE = "https://www.googleapis.com/youtube/v3"


# ── YouTube API helpers ───────────────────────────────────────────────────────

def yt_get(endpoint: str, params: dict, api_key: str) -> dict:
    params["key"] = api_key
    url = f"{YT_API_BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"  ⚠️  YouTube API error ({endpoint}): {e}", flush=True)
        return {}


def search_channels(query: str, api_key: str, max_results: int = 5) -> list:
    """Busca canales relevantes para el nicho."""
    data = yt_get("search", {
        "part":       "snippet",
        "q":          query,
        "type":       "channel",
        "maxResults": max_results,
        "relevanceLanguage": "es",
        "order":      "relevance",
    }, api_key)
    return data.get("items", [])


def get_channel_stats(channel_ids: list, api_key: str) -> list:
    """Obtiene estadísticas reales de los canales."""
    if not channel_ids:
        return []
    data = yt_get("channels", {
        "part": "statistics,snippet,contentDetails",
        "id":   ",".join(channel_ids),
    }, api_key)
    return data.get("items", [])


def get_channel_top_videos(channel_id: str, api_key: str, max_results: int = 5) -> list:
    """Obtiene los videos más vistos del canal (últimos 90 días)."""
    since = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%SZ")
    search_data = yt_get("search", {
        "part":           "snippet",
        "channelId":      channel_id,
        "type":           "video",
        "order":          "viewCount",
        "publishedAfter": since,
        "maxResults":     max_results,
    }, api_key)
    items = search_data.get("items", [])
    if not items:
        return []

    video_ids = [i["id"]["videoId"] for i in items if i.get("id", {}).get("videoId")]
    if not video_ids:
        return []

    videos_data = yt_get("videos", {
        "part": "statistics,snippet,contentDetails",
        "id":   ",".join(video_ids),
    }, api_key)
    return videos_data.get("items", [])


def format_duration(iso: str) -> str:
    """Convierte PT4M13S → 4:13"""
    try:
        import re
        m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso)
        if not m:
            return iso
        h, mn, s = (int(x or 0) for x in m.groups())
        if h:
            return f"{h}:{mn:02d}:{s:02d}"
        return f"{mn}:{s:02d}"
    except Exception:
        return iso


def build_real_data_context(query: str, api_key: str) -> str:
    """Construye contexto con datos reales de YouTube para el LLM."""
    if not api_key:
        return ""

    # Extraer solo keywords de nicho/contenido para YouTube API
    import re as _re
    _STOP = {
        "analiza","analizar","canal","canales","tiktok","youtube","nicho","quiero","saber",
        "busca","buscar","sobre","este","para","como","qué","que","los","las","del","una",
        "video","videos","referencia","información","datos","encuentra","debilidades","rivales",
        "exitosos","más","mejor","español","español","hispanohablante","también","igualmente",
        "tengo","tiene","tiene","están","haciendo","podemos","podemos","aprovechar","siguiente",
    }
    _clean = _re.sub(r'https?://\S+', '', query)
    _clean = _re.sub(r'@\w+', '', _clean)
    _clean = _re.sub(r'[^\w\sáéíóúüñÁÉÍÓÚÜÑ]', ' ', _clean)
    _clean = _re.sub(r'\s+', ' ', _clean).strip()
    _words = [
        w for w in _clean.split()
        if len(w) > 3 and w.lower() not in _STOP
    ][:6]
    query  = ' '.join(_words)[:60] or "canal youtube español viral"
    print(f"  📡 Buscando canales para: '{query}'", flush=True)
    channel_items = search_channels(query, api_key, max_results=5)
    if not channel_items:
        print("  ⚠️  Sin resultados de canales", flush=True)
        return ""

    channel_ids = [i["id"]["channelId"] for i in channel_items if i.get("id", {}).get("channelId")]
    if not channel_ids:
        return ""

    channel_stats = get_channel_stats(channel_ids, api_key)
    if not channel_stats:
        return ""

    lines = ["## 📊 DATOS REALES DE YOUTUBE (obtenidos ahora mismo)\n"]
    lines.append(f"Consulta: '{query}' | Fecha: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}\n")

    for ch in channel_stats[:5]:
        snippet = ch.get("snippet", {})
        stats   = ch.get("statistics", {})
        name    = snippet.get("title", "?")
        subs    = int(stats.get("subscriberCount", 0))
        views   = int(stats.get("viewCount", 0))
        videos  = int(stats.get("videoCount", 0))
        ch_id   = ch.get("id", "")

        lines.append(f"### Canal: {name}")
        lines.append(f"- Suscriptores: {subs:,}")
        lines.append(f"- Views totales: {views:,}")
        lines.append(f"- Videos publicados: {videos:,}")
        if videos > 0:
            lines.append(f"- Promedio views/video (estimado): {views // videos:,}")
        lines.append(f"- URL: https://youtube.com/channel/{ch_id}")

        # Top videos
        print(f"  📹 Obteniendo top videos de {name}...", flush=True)
        top_videos = get_channel_top_videos(ch_id, api_key, max_results=3)
        if top_videos:
            lines.append("- **Top videos (últimos 90 días):**")
            for v in top_videos:
                v_snippet = v.get("snippet", {})
                v_stats   = v.get("statistics", {})
                v_content = v.get("contentDetails", {})
                title     = v_snippet.get("title", "?")
                v_views   = int(v_stats.get("viewCount", 0))
                likes     = int(v_stats.get("likeCount", 0))
                duration  = format_duration(v_content.get("duration", ""))
                published = v_snippet.get("publishedAt", "")[:10]
                tags      = v_snippet.get("tags", [])[:5]
                lines.append(f"  • \"{title}\"")
                lines.append(f"    Views: {v_views:,} | Likes: {likes:,} | Duración: {duration} | Fecha: {published}")
                if tags:
                    lines.append(f"    Tags: {', '.join(tags)}")
        lines.append("")

    return "\n".join(lines)


SYSTEM_PROMPT = """Eres el analista de canales de contenido viral más preciso para el mercado hispanohablante. Recibes DATOS REALES de YouTube y los conviertes en estrategia accionable.

No describes canales — extraes los patrones exactos, medibles y replicables que convierten videos mediocres en millones de vistas.

## ESTRUCTURA — 6 secciones obligatorias:

### 1. 🪝 DISECCIÓN DEL HOOK (los primeros 3 segundos)
Basándote en los títulos reales proporcionados:
- Las 5 frases de apertura exactas más usadas en videos con más vistas (copia o adapta de los títulos reales)
- Tipo de hook dominante: ¿confesión íntima / pregunta que hiere / declaración provocadora / dato que asusta / promesa?
- Patrón de los primeros 3 segundos más frecuente

### 2. 🗺️ MAPA DE RETENCIÓN SEGUNDO A SEGUNDO
Para videos de este nicho con mayor retención:
- Segundo 0-3: qué pasa exactamente
- Segundo 3-15: cómo construyen tensión
- Segundo 15-40: el giro o revelación
- Segundo 40-70: clímax emocional
- Segundo 70-final: CTA

### 3. 🎙️ PSICOLOGÍA NARRATIVA
- Persona gramatical que más retiene
- Ritmo de edición dominante
- Las 5 frases que DESTROZAN la retención
- Las 5 frases que DISPARAN los comentarios

### 4. 👁️ CÓDIGO VISUAL DEL NICHO
- Thumbnail ganador: color dominante, expresión facial, texto overlay
- Iluminación dominante
- El elemento visual que aparece en el 80% de los videos virales

### 5. 💬 PSICOLOGÍA DE LOS COMENTARIOS
- Tipo de comentario más frecuente
- Las 3 frases que más se repiten con 500+ likes
- Qué hace que alguien comparta este video

### 6. 🏆 FÓRMULA PARA DOMINAR EL NICHO
- La fórmula completa: [HOOK] + [estructura] + [elemento visual] + [CTA]
- Los 3 errores que cometen el 90% de los canales mediocres
- El ángulo sin explotar con demanda comprobada

## REGLAS: usa los datos reales proporcionados como base. Cita números reales de los canales analizados. Adapta todo al nicho pedido.
"""


def main():
    api_key    = os.environ.get("OPENROUTER_API_KEY", "")
    yt_api_key = os.environ.get("YOUTUBE_API_KEY_CHANNEL_ANALYZER", "")

    if not api_key:
        print("ERROR: OPENROUTER_API_KEY no configurada", file=sys.stderr)
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    if len(sys.argv) > 1:
        task = " ".join(sys.argv[1:])
    elif issue_title:
        task = issue_body if issue_body and len(issue_body) > len(issue_title) else issue_title
    else:
        task = sys.stdin.read().strip()

    if issue_title:
        post_issue_comment(
            f"📊 Analizando canales del nicho: **{issue_title}**\n\n"
            f"{'🔑 Obteniendo datos reales de YouTube API...' if yt_api_key else '⚠️ Sin YouTube API key — análisis solo con LLM'}"
        )

    if not task:
        task = "crimen real español TikTok YouTube"

    # Obtener datos reales de YouTube
    real_data = ""
    if yt_api_key:
        print("🔑 YouTube API key detectada — fetching real data...", flush=True)
        real_data = build_real_data_context(task, yt_api_key)
        if real_data:
            print(f"  ✅ Datos YouTube obtenidos ({len(real_data)} chars)", flush=True)
        else:
            print("  ⚠️  No se obtuvieron datos de YouTube, continuando con LLM puro", flush=True)
    else:
        print("⚠️  YOUTUBE_API_KEY_CHANNEL_ANALYZER no configurada — modo LLM puro", flush=True)

    # Obtener datos reales del canal de TikTok si se menciona un @usuario
    import re as _re2
    tiktok_data = ""
    _tt_handle = _re2.search(r'@([\w.]+)', task)
    if _tt_handle and os.environ.get("TIKTOK_CLIENT_KEY"):
        print(f"📱 TikTok Research: obteniendo datos de @{_tt_handle.group(1)}...", flush=True)
        try:
            tiktok_data = tt_channel_context(_tt_handle.group(1))
            if tiktok_data:
                print(f"  ✅ Datos TikTok canal obtenidos ({len(tiktok_data)} chars)", flush=True)
        except Exception as e:
            print(f"  ⚠️  TikTok Research error: {e}", flush=True)

    # Fallback: Google Trends si no hay canal específico
    if not tiktok_data:
        print("📱 Obteniendo tendencias de Google Trends...", flush=True)
        try:
            tiktok_data = build_tiktok_trends_context(["mx", "es"])
            if tiktok_data:
                print(f"  ✅ Datos Google Trends obtenidos ({len(tiktok_data)} chars)", flush=True)
        except Exception as e:
            print(f"  ⚠️  Google Trends error: {e}", flush=True)

    # Construir prompt con datos reales
    memory_ctx  = get_context_summary("channel_analyzer", task)
    user_prompt = f"Analiza este canal o nicho: {task}\n\n"
    if real_data:
        user_prompt += f"{real_data}\n\n"
    if tiktok_data:
        user_prompt += f"{tiktok_data}\n\n"
    if real_data or tiktok_data:
        user_prompt += "---\nCon estos datos reales de YouTube y TikTok, realiza el análisis completo según la estructura."
    if memory_ctx:
        user_prompt += f"\n\n---\nCONTEXTO PREVIO:\n{memory_ctx}"

    try:
        response = call_llm(
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt},
            ],
            api_key    = api_key,
            max_tokens = 2500,
            title      = "Paperclip - Channel Analyzer",
            model      = "anthropic/claude-sonnet-4-5",
        )
        save("channel_analyzer", task[:60], response)

        # Guardar canales analizados en Supabase
        if db_configured():
            for ch in (channel_stats if 'channel_stats' in dir() and channel_stats else []):
                snippet = ch.get("snippet", {})
                stats   = ch.get("statistics", {})
                subs    = int(stats.get("subscriberCount", 0))
                views   = int(stats.get("viewCount", 0))
                vids    = int(stats.get("videoCount", 1))
                save_channel(
                    channel_name = snippet.get("title", ""),
                    subscribers  = subs,
                    avg_views    = views // vids if vids else 0,
                    niche        = task[:100],
                    insights     = response[:2000],
                    issue_id     = os.environ.get("PAPERCLIP_ISSUE_ID", ""),
                )

        print(response, flush=True)
        post_issue_result(response)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
