"""
Módulo: TikTok Research API
Acceso a datos reales de TikTok via Research API v2.

Variables de entorno:
  TIKTOK_CLIENT_KEY    → Client Key de la app
  TIKTOK_CLIENT_SECRET → Client Secret

Funciones principales:
  get_access_token()           → Bearer token (caduca en ~2h)
  query_videos(...)            → Videos trending por keyword/hashtag/región
  get_user_info(username)      → Stats reales de un canal
  build_research_context(...)  → Contexto completo para LLM
"""
import os
import json
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone, timedelta

TIKTOK_API = "https://open.tiktokapis.com/v2"

# Cache de token en memoria (evita re-autenticar en cada llamada)
_token_cache = {"token": "", "expires_at": 0}


# ── Auth ──────────────────────────────────────────────────────────────────────

def get_access_token(client_key: str = "", client_secret: str = "") -> str:
    """
    Obtiene un Bearer token via Client Credentials flow.
    Cachea el token hasta 30 min antes de que expire.
    """
    global _token_cache

    if not client_key:
        client_key = os.environ.get("TIKTOK_CLIENT_KEY", "").strip()
    if not client_secret:
        client_secret = os.environ.get("TIKTOK_CLIENT_SECRET", "").strip()

    if not client_key or not client_secret:
        print("  ⚠️  TikTok Research: TIKTOK_CLIENT_KEY/SECRET no configurados", flush=True)
        return ""

    # Usar token cacheado si aún es válido
    if _token_cache["token"] and time.time() < _token_cache["expires_at"]:
        return _token_cache["token"]

    data = urllib.parse.urlencode({
        "client_key":    client_key,
        "client_secret": client_secret,
        "grant_type":    "client_credentials",
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{TIKTOK_API}/oauth/token/",
        data    = data,
        headers = {"Content-Type": "application/x-www-form-urlencoded"},
        method  = "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read().decode("utf-8"))
        token      = resp.get("access_token", "")
        expires_in = int(resp.get("expires_in", 7200))
        if token:
            _token_cache = {
                "token":      token,
                "expires_at": time.time() + expires_in - 1800,  # renovar 30 min antes
            }
            print(f"  ✅ TikTok token obtenido (válido {expires_in//3600}h)", flush=True)
        return token
    except Exception as e:
        print(f"  ⚠️  TikTok token error: {e}", flush=True)
        return ""


def _research_post(endpoint: str, payload: dict, token: str) -> dict:
    """POST a la Research API con Bearer token."""
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        f"{TIKTOK_API}{endpoint}",
        data    = data,
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type":  "application/json",
        },
        method  = "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")[:400]
        except Exception: pass
        print(f"  ⚠️  TikTok Research HTTP {e.code}: {body}", flush=True)
        return {}
    except Exception as e:
        print(f"  ⚠️  TikTok Research error: {e}", flush=True)
        return {}


# ── User Info ─────────────────────────────────────────────────────────────────

def get_user_info(username: str, token: str = "") -> dict:
    """
    Obtiene stats reales de un canal de TikTok.
    username: sin @, ej: "conspiracionnocturna"
    """
    if not token:
        token = get_access_token()
    if not token:
        return {}

    username = username.lstrip("@").strip()
    fields   = "display_name,bio_description,avatar_url,is_verified,follower_count,following_count,likes_count,video_count"

    resp = _research_post(
        f"/research/user/info/?fields={fields}",
        {"username": username},
        token,
    )
    return resp.get("data", {})


# ── Video Query ───────────────────────────────────────────────────────────────

def query_videos(
    token:      str,
    keywords:   list = None,
    hashtags:   list = None,
    regions:    list = None,
    days_back:  int  = 7,
    max_count:  int  = 20,
    fields:     str  = "id,video_description,create_time,region_code,share_count,view_count,like_count,comment_count,hashtag_names,username,voice_to_text",
) -> list:
    """
    Busca videos de TikTok por keyword, hashtag y región.

    keywords:  ["conspiraciones", "misterio"]
    hashtags:  ["conspiraciones2026", "misteriosin resolver"]
    regions:   ["MX", "ES", "CO", "AR"]
    days_back: cuántos días hacia atrás buscar
    """
    if not token:
        return []

    end_date   = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days_back)

    # Construir condiciones
    conditions = []
    if keywords:
        for kw in keywords[:3]:  # max 3 keywords
            conditions.append({
                "operation":   "EQ",
                "field_name":  "keyword",
                "field_values": [kw],
            })
    if hashtags:
        conditions.append({
            "operation":   "IN",
            "field_name":  "hashtag_name",
            "field_values": hashtags[:10],
        })
    if regions:
        conditions.append({
            "operation":   "IN",
            "field_name":  "region_code",
            "field_values": regions,
        })

    if not conditions:
        conditions.append({
            "operation":   "IN",
            "field_name":  "region_code",
            "field_values": ["MX", "ES", "CO"],
        })

    query = {"or": conditions} if len(conditions) > 1 else {"and": conditions}

    payload = {
        "query":      query,
        "max_count":  min(max_count, 100),
        "cursor":     0,
        "start_date": start_date.strftime("%Y%m%d"),
        "end_date":   end_date.strftime("%Y%m%d"),
        "is_random":  False,
    }

    resp   = _research_post(f"/research/video/query/?fields={fields}", payload, token)
    videos = resp.get("data", {}).get("videos", [])
    return videos


# ── Context Builder ───────────────────────────────────────────────────────────

def format_number(n) -> str:
    n = int(n or 0)
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.0f}K"
    return str(n)


def build_channel_context(username: str) -> str:
    """Contexto de un canal específico para Channel Analyzer."""
    print(f"  📱 TikTok Research: analizando @{username}...", flush=True)
    token = get_access_token()
    if not token:
        return ""

    info = get_user_info(username, token)
    if not info:
        print(f"  ⚠️  No se obtuvo info de @{username}", flush=True)
        return ""

    lines = [f"## 📱 DATOS REALES DE TIKTOK — @{username}\n"]
    lines.append(f"| Métrica | Valor |")
    lines.append(f"|---|---|")
    lines.append(f"| Nombre | {info.get('display_name', username)} |")
    lines.append(f"| Seguidores | **{format_number(info.get('follower_count', 0))}** |")
    lines.append(f"| Likes totales | {format_number(info.get('likes_count', 0))} |")
    lines.append(f"| Videos | {info.get('video_count', '?')} |")
    lines.append(f"| Verificado | {'✅' if info.get('is_verified') else '❌'} |")
    if info.get('bio_description'):
        lines.append(f"| Bio | {info['bio_description'][:100]} |")
    lines.append("")

    # Videos recientes del canal
    print(f"  📱 Buscando videos recientes de @{username}...", flush=True)
    videos = query_videos(
        token     = token,
        keywords  = [username],
        regions   = ["MX", "ES", "CO", "AR", "US"],
        days_back = 30,
        max_count = 10,
    )

    if videos:
        # Ordenar por views
        videos.sort(key=lambda v: int(v.get("view_count", 0)), reverse=True)
        lines.append(f"### 🎬 Top videos recientes (últimos 30 días)\n")
        for v in videos[:8]:
            desc     = (v.get("video_description") or v.get("voice_to_text") or "")[:80]
            views    = format_number(v.get("view_count", 0))
            likes    = format_number(v.get("like_count", 0))
            shares   = format_number(v.get("share_count", 0))
            comments = format_number(v.get("comment_count", 0))
            hashtags = " ".join(f"#{h}" for h in (v.get("hashtag_names") or [])[:5])
            lines.append(f"- **\"{desc}\"**")
            lines.append(f"  👁 {views} views · ❤️ {likes} · 🔁 {shares} · 💬 {comments}")
            if hashtags:
                lines.append(f"  {hashtags}")

    return "\n".join(lines)


def build_trending_context(keywords: list, hashtags: list = None, regions: list = None) -> str:
    """Contexto de videos trending para Deep Search."""
    print(f"  📱 TikTok Research: buscando trending {keywords}...", flush=True)
    token = get_access_token()
    if not token:
        return ""

    if regions is None:
        regions = ["MX", "ES", "CO", "AR"]

    videos = query_videos(
        token      = token,
        keywords   = keywords,
        hashtags   = hashtags,
        regions    = regions,
        days_back  = 7,
        max_count  = 20,
    )

    if not videos:
        print("  ⚠️  TikTok Research: sin resultados", flush=True)
        return ""

    # Ordenar por engagement
    videos.sort(key=lambda v: int(v.get("like_count", 0)) + int(v.get("share_count", 0)), reverse=True)

    lines = [f"## 📱 VIDEOS TRENDING TIKTOK — Datos reales (últimos 7 días)\n"]
    lines.append(f"Keywords: {', '.join(keywords)} | Regiones: {', '.join(regions)}\n")

    for i, v in enumerate(videos[:15], 1):
        desc     = (v.get("video_description") or v.get("voice_to_text") or "(sin descripción)")[:100]
        views    = format_number(v.get("view_count", 0))
        likes    = format_number(v.get("like_count", 0))
        shares   = format_number(v.get("share_count", 0))
        region   = v.get("region_code", "?")
        username = v.get("username", "?")
        hashtags_list = v.get("hashtag_names") or []
        hashtags_str  = " ".join(f"#{h}" for h in hashtags_list[:6])

        lines.append(f"**{i}. @{username}** ({region})")
        lines.append(f'"{desc}"')
        lines.append(f"👁 {views} views · ❤️ {likes} likes · 🔁 {shares} shares")
        if hashtags_str:
            lines.append(f"{hashtags_str}")
        lines.append("")

    return "\n".join(lines)
