"""
Agente: TikTok Publisher
Publica el video MP4 generado por el pipeline directamente en TikTok.

Variables de entorno:
  TIKTOK_CLIENT_KEY       → Client Key de la app (aw8evocrc...)
  TIKTOK_CLIENT_SECRET    → Client Secret
  TIKTOK_ACCESS_TOKEN     → Access token del usuario (obtenido via /auth/tiktok/start)
  TIKTOK_REFRESH_TOKEN    → Refresh token (para renovar el access token)

Input (JSON del Video Assembler o Director):
{
  "video_url":  "https://...",       // URL pública del video (o local path)
  "video_path": "/tmp/video.mp4",    // path local del video en el container
  "caption":    "Texto del video...",
  "hashtags":   ["#crimen", "#viral"],
  "tema":       "nombre del tema"
}

Flujo de autenticación (una sola vez):
  Abre: https://tu-railway-url/auth/tiktok/start
  Aprueba en TikTok → te da TIKTOK_ACCESS_TOKEN y TIKTOK_REFRESH_TOKEN
  Añádelos en Railway Variables
"""
import os
import sys
import json
import re
import time
import urllib.request
import urllib.error
import urllib.parse
import tempfile
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

TIKTOK_API = "https://open.tiktokapis.com/v2"
MAX_CAPTION_LEN = 2200
CHUNK_SIZE = 5 * 1024 * 1024  # 5MB por chunk


# ── Auth helpers ─────────────────────────────────────────────────────────────

def refresh_access_token(client_key: str, client_secret: str, refresh_token: str) -> dict:
    """Renueva el access token usando el refresh token."""
    url  = "https://open.tiktokapis.com/v2/oauth/token/"
    data = urllib.parse.urlencode({
        "client_key":     client_key,
        "client_secret":  client_secret,
        "grant_type":     "refresh_token",
        "refresh_token":  refresh_token,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def get_user_info(access_token: str) -> dict:
    """Obtiene el open_id y display_name del usuario."""
    url = f"{TIKTOK_API}/user/info/?fields=open_id,display_name,avatar_url"
    req = urllib.request.Request(url,
                                 headers={"Authorization": f"Bearer {access_token}"},
                                 method="GET")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


# ── Upload helpers ────────────────────────────────────────────────────────────

def download_video(video_url: str) -> bytes:
    """Descarga el video desde una URL."""
    print(f"  📥 Descargando video: {video_url[:80]}...", flush=True)
    req = urllib.request.Request(video_url, method="GET")
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    print(f"  ✅ Video descargado: {len(data) / 1024 / 1024:.1f} MB", flush=True)
    return data


def read_video_file(video_path: str) -> bytes:
    """Lee un video desde el filesystem local."""
    with open(video_path, "rb") as f:
        return f.read()


def init_video_upload(access_token: str, video_size: int, caption: str,
                      privacy: str = "SELF_ONLY") -> dict:
    """
    Inicializa el upload del video.
    privacy: SELF_ONLY (sandbox) | PUBLIC_TO_EVERYONE | FOLLOWER_OF_CREATOR | MUTUAL_FOLLOW_FRIENDS
    """
    chunk_count = max(1, (video_size + CHUNK_SIZE - 1) // CHUNK_SIZE)
    url  = f"{TIKTOK_API}/post/publish/video/init/"
    body = {
        "post_info": {
            "title":           caption[:MAX_CAPTION_LEN],
            "privacy_level":   privacy,
            "disable_duet":    False,
            "disable_comment": False,
            "disable_stitch":  False,
        },
        "source_info": {
            "source":      "FILE_UPLOAD",
            "video_size":  video_size,
            "chunk_size":  CHUNK_SIZE,
            "total_chunk_count": chunk_count,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type":  "application/json; charset=UTF-8",
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def upload_video_chunks(upload_url: str, video_data: bytes) -> bool:
    """Sube el video en chunks al upload_url proporcionado por TikTok."""
    total_size = len(video_data)
    chunk_count = max(1, (total_size + CHUNK_SIZE - 1) // CHUNK_SIZE)
    print(f"  📤 Subiendo video en {chunk_count} chunk(s)...", flush=True)

    for i in range(chunk_count):
        start = i * CHUNK_SIZE
        end   = min(start + CHUNK_SIZE, total_size)
        chunk = video_data[start:end]

        headers = {
            "Content-Type":  "video/mp4",
            "Content-Range": f"bytes {start}-{end - 1}/{total_size}",
            "Content-Length": str(len(chunk)),
        }
        req = urllib.request.Request(upload_url, data=chunk, headers=headers, method="PUT")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status = r.status
            print(f"  ✅ Chunk {i+1}/{chunk_count} → HTTP {status}", flush=True)
        except urllib.error.HTTPError as e:
            print(f"  ❌ Chunk {i+1} falló: HTTP {e.code}", flush=True)
            return False

    return True


def check_publish_status(publish_id: str, access_token: str, max_wait: int = 120) -> dict:
    """Polling hasta que el video esté publicado."""
    url  = f"{TIKTOK_API}/post/publish/status/fetch/"
    body = {"publish_id": publish_id}
    deadline = time.time() + max_wait

    while time.time() < deadline:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type":  "application/json; charset=UTF-8",
            },
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data   = json.loads(r.read().decode("utf-8"))
            status = data.get("data", {}).get("status", "")
            print(f"  ⏳ Publish status: {status}", flush=True)
            if status in ("PUBLISH_COMPLETE", "SUCCESS"):
                return data
            if status in ("FAILED", "ERROR"):
                return data
        except Exception as e:
            print(f"  ⚠️  Status check error: {e}", flush=True)

        time.sleep(8)

    return {"data": {"status": "TIMEOUT"}}


# ── Caption builder ───────────────────────────────────────────────────────────

def build_caption(tema: str, hashtags: list, raw_caption: str = "") -> str:
    """Construye el caption final con hashtags."""
    base = raw_caption or tema or "Historia impactante"
    tags = " ".join(h if h.startswith("#") else f"#{h}" for h in hashtags[:10])
    caption = f"{base}\n\n{tags}" if tags else base
    return caption[:MAX_CAPTION_LEN]


def extract_params(raw: str) -> dict:
    """Extrae parámetros del input."""
    json_str = None
    if "```json" in raw:
        json_str = raw.split("```json")[1].split("```")[0].strip()
    elif raw.strip().startswith("{"):
        json_str = raw.strip()
    else:
        m = re.search(r'\{[\s\S]*?"video_(?:url|path)"[\s\S]*?\}', raw)
        if m:
            json_str = m.group(0)
    if json_str:
        try:
            return json.loads(json_str)
        except Exception:
            pass
    return {}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    client_key     = os.environ.get("TIKTOK_CLIENT_KEY", "").strip()
    client_secret  = os.environ.get("TIKTOK_CLIENT_SECRET", "").strip()
    access_token   = os.environ.get("TIKTOK_ACCESS_TOKEN", "").strip()
    refresh_token  = os.environ.get("TIKTOK_REFRESH_TOKEN", "").strip()

    if not client_key or not client_secret:
        print("ERROR: TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET no configurados", file=sys.stderr)
        sys.exit(1)

    if not access_token:
        msg = (
            "❌ **TikTok Publisher**: No hay access token.\n\n"
            "Para configurarlo, abre en el navegador:\n"
            f"`{os.environ.get('PAPERCLIP_API_URL', 'https://tu-railway-url')}/auth/tiktok/start`\n\n"
            "Aprueba el acceso en TikTok y copia los tokens en Railway Variables."
        )
        post_issue_comment(msg)
        post_issue_result(msg)
        return

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])

    params = extract_params(raw)

    video_url  = params.get("video_url", "")
    video_path = params.get("video_path", "")
    tema       = params.get("tema", issue_title or "Video viral")
    hashtags   = params.get("hashtags", ["#viral", "#fyp", "#español"])
    raw_caption = params.get("caption", "")

    if not video_url and not video_path:
        post_issue_result("❌ TikTok Publisher: No se recibió video_url ni video_path.")
        return

    # Determinar privacidad según entorno
    dry_run  = os.environ.get("TRADING_DRY_RUN", "true").lower() != "false"
    privacy  = "SELF_ONLY"  # Sandbox siempre SELF_ONLY; en prod cambiar a PUBLIC_TO_EVERYONE
    env_priv = os.environ.get("TIKTOK_PRIVACY", "SELF_ONLY")
    privacy  = env_priv

    caption = build_caption(tema, hashtags, raw_caption)

    post_issue_comment(
        f"📱 **TikTok Publisher** iniciando...\n\n"
        f"🎬 Tema: {tema[:60]}\n"
        f"🔒 Privacidad: `{privacy}`\n"
        f"📝 Caption: {caption[:100]}..."
    )

    # Renovar token si hay refresh token
    if refresh_token:
        try:
            print("🔄 Renovando access token...", flush=True)
            token_data    = refresh_access_token(client_key, client_secret, refresh_token)
            new_token     = token_data.get("access_token", "")
            new_refresh   = token_data.get("refresh_token", "")
            if new_token:
                access_token  = new_token
                refresh_token = new_refresh
                print("  ✅ Token renovado", flush=True)
        except Exception as e:
            print(f"  ⚠️  No se pudo renovar token: {e}", flush=True)

    # Obtener video data
    try:
        if video_path and os.path.exists(video_path):
            video_data = read_video_file(video_path)
        elif video_url:
            video_data = download_video(video_url)
        else:
            post_issue_result("❌ No se encontró el video para publicar.")
            return
    except Exception as e:
        post_issue_result(f"❌ Error descargando video: {e}")
        return

    video_size = len(video_data)
    print(f"📦 Video size: {video_size / 1024 / 1024:.1f} MB", flush=True)

    # Init upload
    try:
        print("🚀 Inicializando upload en TikTok...", flush=True)
        init_resp  = init_video_upload(access_token, video_size, caption, privacy)
        error_code = init_resp.get("error", {}).get("code", "ok")
        if error_code != "ok":
            raise Exception(f"Init error: {init_resp.get('error', {})}")

        upload_url  = init_resp["data"]["upload_url"]
        publish_id  = init_resp["data"]["publish_id"]
        print(f"  ✅ Upload iniciado → publish_id: {publish_id}", flush=True)
    except Exception as e:
        post_issue_result(f"❌ Error inicializando upload: {e}")
        return

    # Upload chunks
    if not upload_video_chunks(upload_url, video_data):
        post_issue_result("❌ Error subiendo chunks del video a TikTok.")
        return

    # Poll publish status
    print("⏳ Esperando confirmación de publicación...", flush=True)
    status_resp = check_publish_status(publish_id, access_token)
    status      = status_resp.get("data", {}).get("status", "UNKNOWN")

    if status in ("PUBLISH_COMPLETE", "SUCCESS"):
        video_id = status_resp.get("data", {}).get("publicaly_available_post_id", [""])[0]
        result = (
            f"# 📱 TIKTOK PUBLISHER — ✅ Publicado\n\n"
            f"**Tema:** {tema}\n"
            f"**Caption:** {caption[:200]}\n"
            f"**Privacidad:** {privacy}\n"
            f"**Publish ID:** `{publish_id}`\n"
            + (f"**Video ID:** `{video_id}`\n" if video_id else "")
            + f"\n🎉 Video publicado exitosamente en TikTok."
        )
    else:
        result = (
            f"# 📱 TIKTOK PUBLISHER — ⚠️ Estado: {status}\n\n"
            f"Publish ID: `{publish_id}`\n"
            f"Respuesta: `{json.dumps(status_resp.get('data', {}))[:300]}`"
        )

    print(result[:200], flush=True)
    post_issue_result(result)


if __name__ == "__main__":
    main()
