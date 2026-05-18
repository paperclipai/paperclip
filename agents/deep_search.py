"""
Agente: Deep Search YouTube & TikTok
Busca tendencias virales con DATOS REALES via YouTube Data API v3 + LLM analysis.
"""
import os
import sys
import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from memory import get_context_summary, save, append_keywords
from api_client import call_llm, post_issue_result, post_issue_comment, resolve_issue_context
from tiktok_trends import build_tiktok_trends_context
from tiktok_research import build_trending_context as tt_trending_context
from db_client import save_trends, is_configured as db_configured

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


def search_trending_videos(query: str, api_key: str, days: int = 7,
                            max_results: int = 10, region: str = "MX") -> list:
    """Busca videos trending del nicho en los últimos N días."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    data  = yt_get("search", {
        "part":              "snippet",
        "q":                 query,
        "type":              "video",
        "order":             "viewCount",
        "publishedAfter":    since,
        "maxResults":        max_results,
        "relevanceLanguage": "es",
        "regionCode":        region,
        "videoDuration":     "short",   # shorts y videos cortos
    }, api_key)
    return data.get("items", [])


def get_video_details(video_ids: list, api_key: str) -> list:
    """Obtiene estadísticas detalladas de los videos."""
    if not video_ids:
        return []
    data = yt_get("videos", {
        "part": "statistics,snippet,contentDetails",
        "id":   ",".join(video_ids[:10]),
    }, api_key)
    return data.get("items", [])


def get_regional_trending(api_key: str, region: str = "MX", category: str = "25") -> list:
    """Obtiene videos trending por región (25 = Noticias, 24 = Entertainment)."""
    data = yt_get("videos", {
        "part":              "statistics,snippet",
        "chart":             "mostPopular",
        "regionCode":        region,
        "videoCategoryId":   category,
        "maxResults":        10,
        "relevanceLanguage": "es",
    }, api_key)
    return data.get("items", [])


def format_number(n) -> str:
    n = int(n)
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def build_trending_context(query: str, api_key: str) -> str:
    """Construye contexto de tendencias reales para el LLM."""
    if not api_key:
        return ""

    lines = ["## 📊 DATOS REALES DE YOUTUBE (obtenidos ahora mismo)\n"]
    lines.append(f"Query: '{query}' | Fecha: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n")

    # 1. Videos trending del nicho — últimos 7 días
    # Extraer solo keywords de contenido para YouTube API
    import re as _re
    _STOP = {
        "busca","buscar","tendencias","virales","nicho","quiero","canal","canales",
        "tiktok","youtube","referencia","para","sobre","qué","que","los","las","del",
        "español","hispanohablante","ahora","mismo","esta","semana","atacar","ángulo",
        "diferenciar","diferenciarnos","hashtags","activos","funcionan","hooks",
    }
    _q = _re.sub(r'https?://\S+', '', query)
    _q = _re.sub(r'@\w+', '', _q)
    _q = _re.sub(r'[^\w\sáéíóúüñÁÉÍÓÚÜÑ]', ' ', _q)
    _q = _re.sub(r'\s+', ' ', _q).strip()
    _words = [w for w in _q.split() if len(w) > 3 and w.lower() not in _STOP][:8]
    query  = ' '.join(_words)[:80] or "videos virales español tiktok"
    print(f"  📡 Buscando trending videos: '{query}' (7 días)...", flush=True)
    search_items = search_trending_videos(query, api_key, days=7, max_results=10)
    if search_items:
        video_ids = [i["id"]["videoId"] for i in search_items if i.get("id", {}).get("videoId")]
        details   = get_video_details(video_ids, api_key)

        lines.append("### 🔥 TOP VIDEOS DEL NICHO (últimos 7 días, ordenados por views)\n")
        for v in details[:10]:
            snippet = v.get("snippet", {})
            stats   = v.get("statistics", {})
            title     = snippet.get("title", "?")
            channel   = snippet.get("channelTitle", "?")
            views     = format_number(stats.get("viewCount", 0))
            likes     = format_number(stats.get("likeCount", 0))
            comments  = format_number(stats.get("commentCount", 0))
            published = snippet.get("publishedAt", "")[:10]
            desc      = snippet.get("description", "")[:120].replace("\n", " ")
            tags      = snippet.get("tags", [])[:6]
            vid_id    = v.get("id", "")

            lines.append(f"**\"{title}\"**")
            lines.append(f"- Canal: {channel} | Views: {views} | Likes: {likes} | Comentarios: {comments}")
            lines.append(f"- Publicado: {published}")
            lines.append(f"- Descripción: {desc}...")
            if tags:
                lines.append(f"- Tags: {', '.join(tags)}")
            lines.append(f"- URL: https://youtu.be/{vid_id}")
            lines.append("")

    # 2. Trending MX — Noticias/Entretenimiento
    print("  📡 Buscando trending MX (Entretenimiento)...", flush=True)
    trending_mx = get_regional_trending(api_key, region="MX", category="24")  # Entertainment
    if trending_mx:
        lines.append("### 📱 TRENDING EN MÉXICO AHORA (Entretenimiento)\n")
        for v in trending_mx[:5]:
            snippet = v.get("snippet", {})
            stats   = v.get("statistics", {})
            title   = snippet.get("title", "?")
            views   = format_number(stats.get("viewCount", 0))
            channel = snippet.get("channelTitle", "?")
            lines.append(f"- \"{title}\" — {channel} ({views} views)")

    # 3. Trending ES — España
    print("  📡 Buscando trending ES (España)...", flush=True)
    trending_es = get_regional_trending(api_key, region="ES", category="24")
    if trending_es:
        lines.append("\n### 📱 TRENDING EN ESPAÑA AHORA\n")
        for v in trending_es[:5]:
            snippet = v.get("snippet", {})
            stats   = v.get("statistics", {})
            title   = snippet.get("title", "?")
            views   = format_number(stats.get("viewCount", 0))
            channel = snippet.get("channelTitle", "?")
            lines.append(f"- \"{title}\" — {channel} ({views} views)")

    lines.append("")
    return "\n".join(lines)


SYSTEM_PROMPT = """Eres el investigador de tendencias virales más agudo para contenido en español. Recibes DATOS REALES de YouTube y los conviertes en inteligencia accionable para crear contenido que explote HOY.

## ESTRUCTURA — 6 secciones obligatorias:

### 1. 🔥 TOP 5 TENDENCIAS DEL MOMENTO (basadas en datos reales)
Para cada tendencia, usa los datos reales proporcionados:
- Nombre + views reales + fecha
- Por qué está viral AHORA: el disparador emocional específico
- Potencial de vida: ¿cuántos días más durará?

### 2. 📌 10 TÍTULOS VIRALES (de los datos reales)
Títulos literales de los videos proporcionados con más views. Con la razón psicológica exacta de cada uno.

### 3. 💬 FRASES DE LA AUDIENCIA (para el hook)
Frases textuales que probablemente repite la gente en comentarios de estos videos. Basadas en el tipo de contenido.

### 4. 🧠 MAPA DE EMOCIONES VIRALES
Las 3 emociones dominantes en el nicho esta semana según los datos:
1. [emoción] → disparador → segundo del video
2. [emoción] → disparador → segundo del video
3. [emoción] → disparador → segundo del video

### 5. 🎯 ÁNGULO GANADOR ESTA SEMANA
El enfoque exacto que más va a conectar basado en los datos reales:
- Emoción dominante a explotar
- Perspectiva narrativa recomendada
- Ejemplo de título con este ángulo

### 6. 📱 ESTRATEGIA DE PLATAFORMA
- TikTok: duración ideal, hora pico LATAM, hashtags exactos (máximo 5)
- YouTube Shorts: thumbnail concept, título con keyword
- ¿En qué plataforma publicar PRIMERO y por qué?

## REGLAS: usa los datos reales como base principal. Cita views y títulos reales. Adapta TODO al nicho pedido.
"""


def main():
    api_key    = os.environ.get("OPENROUTER_API_KEY", "")
    yt_api_key = os.environ.get("YOUTUBE_API_KEY_DEEP_SEARCH", "")

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
            f"🔍 Buscando tendencias para: **{issue_title}**\n\n"
            f"{'🔑 Obteniendo datos reales de YouTube API + análisis LLM...' if yt_api_key else '⚠️  Sin YouTube API key — análisis solo con LLM'}"
        )

    if not task:
        task = "crimen real historias impactantes español"

    # Obtener datos reales de YouTube
    real_data = ""
    if yt_api_key:
        print("🔑 YouTube API key detectada — fetching trending data...", flush=True)
        real_data = build_trending_context(task, yt_api_key)
        if real_data:
            print(f"  ✅ Datos YouTube obtenidos ({len(real_data)} chars)", flush=True)
        else:
            print("  ⚠️  Sin datos de YouTube, continuando con LLM puro", flush=True)
    else:
        print("⚠️  YOUTUBE_API_KEY_DEEP_SEARCH no configurada — modo LLM puro", flush=True)

    # Obtener trending de TikTok via Research API (datos reales)
    tiktok_data = ""
    if os.environ.get("TIKTOK_CLIENT_KEY", "").strip():
        print("📱 TikTok Research API: buscando trending...", flush=True)
        try:
            # Extraer keywords para la búsqueda
            import re as _re2
            _kw_raw = _re2.sub(r'[^\w\sáéíóúüñÁÉÍÓÚÜÑ]', ' ', task)
            _kw_words = [w for w in _kw_raw.split() if len(w) > 4][:4]
            _hashtags = _re2.findall(r'#(\w+)', task)
            tiktok_data = tt_trending_context(
                keywords = _kw_words or ["viral", "trending"],
                hashtags = _hashtags or None,
                regions  = ["MX", "ES", "CO", "AR"],
            )
            if tiktok_data:
                print(f"  ✅ TikTok Research datos obtenidos ({len(tiktok_data)} chars)", flush=True)
        except Exception as e:
            print(f"  ⚠️  TikTok Research error: {e}", flush=True)

    # Fallback: Google Trends si Research API falla
    if not tiktok_data:
        print("📱 Fallback: Google Trends...", flush=True)
        try:
            tiktok_data = build_tiktok_trends_context(["mx", "es", "co"])
            if tiktok_data:
                print(f"  ✅ Google Trends obtenidos ({len(tiktok_data)} chars)", flush=True)
        except Exception as e:
            print(f"  ⚠️  Google Trends error: {e}", flush=True)

    # Construir prompt
    memory_ctx  = get_context_summary("deep_search", task)
    user_prompt = f"Busca tendencias para: {task}\n\n"
    if real_data:
        user_prompt += f"{real_data}\n\n"
    if tiktok_data:
        user_prompt += f"{tiktok_data}\n\n"
    if real_data or tiktok_data:
        user_prompt += "---\nCon estos datos reales de YouTube y TikTok, realiza el análisis completo."
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
            title      = "Paperclip - Deep Search",
            model      = "perplexity/sonar-pro",
        )
        save("deep_search", task[:60], response)

        # Guardar tendencias en Supabase
        if db_configured():
            import re as _re
            _yt_items  = [{"title": t} for t in _re.findall(r'"([^"]{10,80})"', real_data)][:10]
            _tt_items  = [{"hashtag": h} for h in _re.findall(r'`(#\w+)`', tiktok_data)][:15]
            _kw_items  = [{"keyword": k} for k in _re.findall(r'`([^`#]{3,30})`', tiktok_data)][:10]
            save_trends(
                tema        = task[:200],
                yt_titles   = _yt_items,
                tt_hashtags = _tt_items,
                keywords    = _kw_items,
                issue_id    = os.environ.get("PAPERCLIP_ISSUE_ID", ""),
            )

        print(response, flush=True)
        post_issue_result(response)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
