"""
Módulo: Supabase DB Client
Cliente ligero para escribir y leer datos del pipeline de contenido.
Usa la REST API de Supabase — sin drivers externos, solo urllib.

Variables de entorno:
  SUPABASE_URL  → https://xxxx.supabase.co/rest/v1/
  SUPABASE_KEY  → sb_secret_...

Tablas disponibles:
  videos    → cada video generado por el Director
  trends    → tendencias capturadas por Deep Search
  channels  → canales analizados por Channel Analyzer
"""
import os
import json
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone


def _get_config() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/") + "/"
    key = os.environ.get("SUPABASE_KEY", "")
    return url, key


def _headers(key: str) -> dict:
    return {
        "apikey":        key,
        "Authorization": f"Bearer {key}",
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
    }


def _post(table: str, payload: dict) -> dict | None:
    """Inserta un registro en Supabase. Devuelve el registro creado o None si falla."""
    url, key = _get_config()
    if not url or not key:
        print(f"  ⚠️  DB: SUPABASE_URL o SUPABASE_KEY no configurados", flush=True)
        return None

    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        f"{url}{table}",
        data    = data,
        headers = _headers(key),
        method  = "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            result = json.loads(r.read().decode("utf-8"))
            return result[0] if isinstance(result, list) and result else result
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception: pass
        print(f"  ⚠️  DB POST {table} → HTTP {e.code}: {body}", flush=True)
        return None
    except Exception as e:
        print(f"  ⚠️  DB POST {table} → {e}", flush=True)
        return None


def _patch(table: str, record_id: str, payload: dict) -> dict | None:
    """Actualiza un registro por ID."""
    url, key = _get_config()
    if not url or not key:
        return None

    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        f"{url}{table}?id=eq.{record_id}",
        data    = data,
        headers = _headers(key),
        method  = "PATCH",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            result = json.loads(r.read().decode("utf-8"))
            return result[0] if isinstance(result, list) and result else result
    except Exception as e:
        print(f"  ⚠️  DB PATCH {table}/{record_id} → {e}", flush=True)
        return None


# ── Public API ────────────────────────────────────────────────────────────────

def save_video(
    tema: str,
    guion: str = "",
    audio_url: str = "",
    video_url: str = "",
    image_urls: list = None,
    hashtags: list = None,
    duration_sec: int = None,
    status: str = "generated",
    platform: str = "tiktok",
    issue_id: str = "",
    director_run: str = "",
) -> str | None:
    """
    Guarda un video generado. Devuelve el UUID creado o None si falla.
    Llama al inicio del Director con status='generating' y actualiza al final.
    """
    record = _post("videos", {
        "tema":         tema[:500] if tema else "",
        "guion":        guion[:8000] if guion else "",
        "audio_url":    audio_url,
        "video_url":    video_url,
        "image_urls":   image_urls or [],
        "hashtags":     hashtags or [],
        "duration_sec": duration_sec,
        "status":       status,
        "platform":     platform,
        "issue_id":     issue_id,
        "director_run": director_run,
    })
    if record:
        vid_id = record.get("id", "")
        print(f"  ✅ DB: video guardado → {vid_id}", flush=True)
        return vid_id
    return None


def update_video(
    video_id: str,
    video_url: str = None,
    audio_url: str = None,
    image_urls: list = None,
    status: str = None,
    guion: str = None,
    hashtags: list = None,
    duration_sec: int = None,
) -> bool:
    """Actualiza un video existente por su UUID."""
    payload = {}
    if video_url    is not None: payload["video_url"]    = video_url
    if audio_url    is not None: payload["audio_url"]    = audio_url
    if image_urls   is not None: payload["image_urls"]   = image_urls
    if status       is not None: payload["status"]       = status
    if guion        is not None: payload["guion"]        = guion[:8000]
    if hashtags     is not None: payload["hashtags"]     = hashtags
    if duration_sec is not None: payload["duration_sec"] = duration_sec
    if not payload:
        return False
    result = _patch("videos", video_id, payload)
    return result is not None


def save_trends(
    tema: str,
    hashtags: list = None,
    yt_titles: list = None,
    tt_hashtags: list = None,
    keywords: list = None,
    issue_id: str = "",
) -> str | None:
    """Guarda las tendencias capturadas por Deep Search."""
    record = _post("trends", {
        "tema":        tema[:500] if tema else "",
        "hashtags":    hashtags or [],
        "yt_titles":   yt_titles or [],
        "tt_hashtags": tt_hashtags or [],
        "keywords":    keywords or [],
        "issue_id":    issue_id,
    })
    if record:
        tid = record.get("id", "")
        print(f"  ✅ DB: trends guardadas → {tid}", flush=True)
        return tid
    return None


def save_channel(
    channel_name: str,
    subscribers: int = 0,
    avg_views: int = 0,
    niche: str = "",
    top_videos: list = None,
    insights: str = "",
    issue_id: str = "",
) -> str | None:
    """Guarda el análisis de un canal competidor."""
    record = _post("channels", {
        "channel_name": channel_name[:200] if channel_name else "",
        "subscribers":  subscribers,
        "avg_views":    avg_views,
        "niche":        niche[:200] if niche else "",
        "top_videos":   top_videos or [],
        "insights":     insights[:5000] if insights else "",
        "issue_id":     issue_id,
    })
    if record:
        cid = record.get("id", "")
        print(f"  ✅ DB: channel guardado → {cid}", flush=True)
        return cid
    return None


def is_configured() -> bool:
    """Verifica si Supabase está configurado."""
    url, key = _get_config()
    return bool(url and key and url != "/")
