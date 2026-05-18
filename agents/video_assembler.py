"""
Agente: Video Assembler
Combina imágenes generadas + audio de narración en un video MP4.
Usa ffmpeg: slideshow de imágenes sincronizado con la voz en off.

Output: MP4 720p 9:16 (formato TikTok/Reels/Shorts)
"""
import os
import sys
import re
import json
import glob
import subprocess
import time
import urllib.request
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, post_parent_update

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def _is_html(data: bytes) -> bool:
    """Detecta respuestas HTML (errores 403/404 disfrazados como 200)."""
    start = data[:100].lower()
    return start.startswith(b"<!doctype") or start.startswith(b"<html") or b"<html" in start[:60]


def download_image(url: str, path: str) -> bool:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Referer": "https://higgsfield.ai/",
        "Cache-Control": "no-cache",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            content_type = r.headers.get("Content-Type", "")
            data = r.read()
        print(f"  📦 Descargado: {len(data)//1024}KB, Content-Type: {content_type[:40]}", flush=True)
        # Rechazar solo respuestas HTML (errores disfrazados)
        if _is_html(data):
            print(f"  ⚠️  Respuesta es HTML (error del servidor): {url[:70]}", flush=True)
            return False
        if len(data) < 500:
            print(f"  ⚠️  Respuesta demasiado pequeña ({len(data)}B): {url[:70]}", flush=True)
            return False
        with open(path, "wb") as f:
            f.write(data)
        print(f"  ✅ Imagen guardada: {path}", flush=True)
        return True
    except Exception as e:
        print(f"  ⚠️  Error descargando {url[:70]}: {e}", flush=True)
        return False


def convert_to_jpg(src: str, dst: str) -> bool:
    """Convierte cualquier formato de imagen a JPG con ffmpeg."""
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", src,
             "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
             "-q:v", "2", dst],
            capture_output=True, text=True, timeout=30
        )
        return r.returncode == 0 and os.path.exists(dst)
    except Exception:
        return False


def extract_image_urls(text: str) -> list:
    urls = re.findall(r"https?://[^\s\"')]+\.(?:png|jpg|jpeg|webp)", text)
    return list(dict.fromkeys(urls))


def download_video_clip(url: str, path: str) -> bool:
    """Descarga un clip de video MP4 desde URL — streaming a disco, sin cargar en RAM."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept":          "*/*",
        "Accept-Encoding": "identity",
        "Referer":         "https://cloud.higgsfield.ai/",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            with open(path, "wb") as f:
                total = 0
                while True:
                    chunk = r.read(256 * 1024)  # 256KB a la vez — sin cargar todo en RAM
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
        if total < 5000:
            print(f"  ⚠️  Clip demasiado pequeño ({total}B): {url[:70]}", flush=True)
            return False
        print(f"  ✅ Clip descargado: {path} ({total//1024}KB)", flush=True)
        return True
    except Exception as e:
        print(f"  ⚠️  Error descargando clip {url[:70]}: {e}", flush=True)
        return False


def stretch_to_audio(silent_video: str, audio_path: str, work_dir: str) -> str:
    """
    Si el video es más corto que el audio, lo estira con setpts para que encaje.
    Devuelve la ruta del video estirado, o el original si no hace falta.
    """
    video_dur = get_audio_duration(silent_video)
    audio_dur = get_audio_duration(audio_path)

    if audio_dur <= 0 or video_dur <= 0:
        return silent_video

    # Solo estirar si el audio supera al video en más de un 5%
    if audio_dur <= video_dur * 1.05:
        print(f"  ⏱️  Video {video_dur:.1f}s ≈ audio {audio_dur:.1f}s — no hace falta estirar", flush=True)
        return silent_video

    factor = audio_dur / video_dur
    print(f"  ⏱️  Estirando video: {video_dur:.1f}s → {audio_dur:.1f}s (×{factor:.2f})", flush=True)

    stretched = os.path.join(work_dir, "silent_stretched.mp4")
    cmd = [
        "ffmpeg", "-y",
        "-i", silent_video,
        "-vf", f"setpts={factor:.6f}*PTS",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-an",
        stretched,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode == 0 and os.path.exists(stretched) and os.path.getsize(stretched) > 1000:
        new_dur = get_audio_duration(stretched)
        print(f"  ✅ Video estirado a {new_dur:.1f}s", flush=True)
        return stretched
    else:
        print(f"  ⚠️  Stretch falló — usando original:\n{r.stderr[-300:]}", flush=True)
        return silent_video


def assemble_from_clips(clip_paths: list, audio_path: str,
                        output_path: str) -> tuple:
    """
    Concatena clips MP4 pre-animados y añade audio.
    Devuelve (ok: bool, total_dur: float).
    """
    work_dir = os.path.dirname(output_path)

    # Normalizar todos los clips a la misma resolución/fps para concat
    norm_clips = []
    scale_filter = (
        "scale=720:1280:force_original_aspect_ratio=decrease,"
        "pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,"
        "format=yuv420p,fps=24"
    )
    for i, src in enumerate(clip_paths):
        # Diagnóstico: mostrar codec/resolución/color del clip original
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,width,height,pix_fmt,color_space,color_transfer,color_primaries",
             "-of", "default=nw=1", src],
            capture_output=True, text=True, timeout=10
        )
        if probe.returncode == 0:
            print(f"  🔍 Clip {i+1} info: {probe.stdout.strip()}", flush=True)

        dst = os.path.join(work_dir, f"norm_clip_{i:02d}.mp4")
        cmd = [
            "ffmpeg", "-y", "-i", src,
            "-vf", scale_filter,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-pix_fmt", "yuv420p",
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            "-threads", "2",
            "-movflags", "+faststart",
            "-an", dst,
        ]
        print(f"  🔄 Normalizando clip {i+1}/{len(clip_paths)}...", flush=True)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 1000:
            norm_clips.append(dst)
            print(f"  ✅ Clip {i+1} normalizado ({os.path.getsize(dst)//1024}KB)", flush=True)
        else:
            print(f"  ⚠️  Clip {i+1} no se pudo normalizar — omitido", flush=True)
            print(f"     stderr: {r.stderr[-400:]}", flush=True)

    if not norm_clips:
        print("  ❌ Sin clips normalizados", flush=True)
        return False, 0.0

    # Concatenar clips
    if len(norm_clips) == 1:
        silent_video = norm_clips[0]
    else:
        filelist = os.path.join(work_dir, "norm_clips_list.txt")
        with open(filelist, "w") as f:
            for c in norm_clips:
                f.write(f"file '{c}'\n")
        silent_video = os.path.join(work_dir, "silent_from_clips.mp4")
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", filelist,
            "-c", "copy", silent_video,
        ]
        print(f"  🔗 Concatenando {len(norm_clips)} clips...", flush=True)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            print(f"  ❌ Concat falló:\n{r.stderr[-600:]}", flush=True)
            return False, 0.0

    total_dur = get_audio_duration(silent_video)

    # Estirar video si el audio es más largo que los clips concatenados
    has_audio = bool(audio_path and os.path.exists(audio_path))
    if has_audio:
        silent_video = stretch_to_audio(silent_video, audio_path, work_dir)
        total_dur    = get_audio_duration(silent_video)

    # Añadir audio
    if has_audio:
        cmd = [
            "ffmpeg", "-y",
            "-i", silent_video, "-i", audio_path,
            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart", "-shortest",
            output_path,
        ]
    else:
        cmd = [
            "ffmpeg", "-y", "-i", silent_video,
            "-c", "copy", "-movflags", "+faststart",
            output_path,
        ]
    print(f"  🎙️  {'Muxeando audio...' if has_audio else 'Video sin audio...'}", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print(f"  ❌ Mux falló:\n{r.stderr[-600:]}", flush=True)
        return False, total_dur

    print(f"  ✅ Video ensamblado desde clips: {output_path} ({os.path.getsize(output_path)//1024}KB)", flush=True)
    return True, total_dur


def extract_audio_url(text: str) -> str:
    """Extrae URL de audio MP3 del texto (para modo standalone)."""
    m = re.search(r"https?://[^\s\"')]+\.mp3", text)
    return m.group(0) if m else ""


def download_audio(url: str, output_path: str) -> bool:
    """Descarga un MP3 desde URL a output_path — streaming a disco."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            with open(output_path, "wb") as f:
                while True:
                    chunk = r.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
        print(f"  ✅ Audio descargado: {output_path}", flush=True)
        return True
    except Exception as e:
        print(f"  ⚠️  Error descargando audio: {e}", flush=True)
        return False


def get_audio_duration(path: str) -> float:
    """Devuelve la duración del audio en segundos."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=10
        )
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def normalize_images(image_paths: list, work_dir: str) -> list:
    """
    Convierte todas las imágenes a JPG estándar para máxima compatibilidad con ffmpeg.
    WebP y otros formatos raros pueden fallar en el concat demuxer.
    """
    normalized = []
    for i, src in enumerate(image_paths):
        dst = os.path.join(work_dir, f"norm_{i+1:02d}.jpg")
        if convert_to_jpg(src, dst):
            normalized.append(dst)
            print(f"  🔄 Normalizada: {os.path.basename(src)} → {os.path.basename(dst)}", flush=True)
        else:
            # Si la conversión falla, intentar usar la original
            print(f"  ⚠️  No se pudo normalizar {os.path.basename(src)}, usando original", flush=True)
            normalized.append(src)
    return normalized


def assemble_video(image_paths: list, audio_path: str,
                   output_path: str, scene_duration: float) -> bool:
    """
    Crea el video con ffmpeg usando el enfoque POR CLIP (no concat demuxer).
    El concat demuxer con imágenes estáticas cuelga en ciertos ffmpeg — en
    cambio, '-loop 1 -t DURATION' es fiable y no requiere seek.

    Pasos:
      1. Normalizar imágenes a JPG
      2. Generar un clip MP4 silencioso por imagen con -loop 1
      3. Concatenar clips con stream copy
      4. Muxear audio en el video final
    """
    work_dir = os.path.dirname(output_path)

    scale_filter = (
        "scale=720:1280:force_original_aspect_ratio=decrease,"
        "pad=720:1280:(ow-iw)/2:(oh-ih)/2:black"
    )

    # Paso 1: normalizar imágenes a JPG
    print(f"  🔄 Normalizando {len(image_paths)} imágenes a JPG...", flush=True)
    norm_paths = normalize_images(image_paths, work_dir)
    if not norm_paths:
        print("  ❌ Sin imágenes normalizadas", flush=True)
        return False

    # Paso 2: generar clip silencioso por imagen (-loop 1, ultrafast, sin seek)
    clip_paths = []
    per_clip_timeout = max(60, int(scene_duration * 3))  # headroom generoso
    for i, img in enumerate(norm_paths):
        clip = os.path.join(work_dir, f"clip_{i:02d}.mp4")
        cmd = [
            "ffmpeg", "-y",
            "-loop", "1",          # loop la imagen como stream de video
            "-framerate", "1",     # entrada a 1fps (reduce trabajo interno)
            "-i", img,
            "-vf", f"{scale_filter},fps=24",   # escalar + convertir a 24fps
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-pix_fmt", "yuv420p",
            "-t", f"{scene_duration:.3f}",     # duración exacta
            "-an",                 # sin audio en el clip
            clip
        ]
        print(f"  🎞️  Clip {i+1}/{len(norm_paths)}: {scene_duration:.1f}s desde {os.path.basename(img)}", flush=True)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=per_clip_timeout)
        if r.returncode != 0:
            print(f"  ❌ Clip {i+1} falló (código {r.returncode}):", flush=True)
            print(f"     stderr: {r.stderr[-800:]}", flush=True)
            return False
        if not os.path.exists(clip) or os.path.getsize(clip) < 1000:
            print(f"  ❌ Clip {i+1} vacío o no existe (tamaño: {os.path.getsize(clip) if os.path.exists(clip) else 0}B)", flush=True)
            print(f"     stderr: {r.stderr[-400:]}", flush=True)
            return False
        sz = os.path.getsize(clip) // 1024
        print(f"  ✅ Clip {i+1} listo: {sz}KB", flush=True)
        clip_paths.append(clip)

    # Paso 3: concatenar clips (stream copy → rápido)
    if len(clip_paths) == 1:
        silent_video = clip_paths[0]
        print(f"  ⏩ Clip único — sin necesidad de concatenar", flush=True)
    else:
        filelist = os.path.join(work_dir, "clips_list.txt")
        with open(filelist, "w", encoding="utf-8") as f:
            for c in clip_paths:
                f.write(f"file '{c}'\n")
        silent_video = os.path.join(work_dir, "silent.mp4")
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", filelist,
            "-c", "copy", silent_video
        ]
        print(f"  🔗 Concatenando {len(clip_paths)} clips...", flush=True)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            print(f"  ❌ Concat falló:\n{r.stderr[-600:]}", flush=True)
            return False
        print(f"  ✅ Clips concatenados", flush=True)

    # Paso 4: muxear audio
    if audio_path:
        exists = os.path.exists(audio_path)
        sz = os.path.getsize(audio_path) // 1024 if exists else 0
        print(f"  🎙️  Audio: '{audio_path}' — exists={exists}, {sz}KB", flush=True)
    else:
        print(f"  🔇 Sin audio_path — video mudo", flush=True)
    has_audio = bool(audio_path and os.path.exists(audio_path))
    if has_audio:
        cmd = [
            "ffmpeg", "-y",
            "-i", silent_video,
            "-i", audio_path,
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            "-shortest",
            output_path
        ]
        print(f"  🎙️  Muxeando audio...", flush=True)
    else:
        cmd = [
            "ffmpeg", "-y",
            "-i", silent_video,
            "-c", "copy",
            "-movflags", "+faststart",
            output_path
        ]
        print(f"  🔇 Video sin audio (mux directo)...", flush=True)

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.stderr:
        print(f"  📋 mux stderr:\n{r.stderr[-800:]}", flush=True)
    if r.returncode != 0:
        print(f"  ❌ Mux falló (código {r.returncode})", flush=True)
        return False

    final_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
    print(f"  ✅ Video ensamblado: {output_path} ({final_size//1024}KB)", flush=True)
    return True


def generate_srt(narration_text: str, total_duration: float, output_path: str) -> bool:
    """
    Genera archivo SRT a partir del texto de narración y la duración total del video.
    Divide en chunks de ~6 palabras para estilo TikTok/Shorts.
    """
    # Limpiar texto: quitar comillas, asteriscos, corchetes, instrucciones de cámara
    text = re.sub(r'["\*\[\]#]+', '', narration_text)
    text = re.sub(r'\b(ESCENA|NARRACIÓN|VOZ EN OFF|HOOK|CTA)\b.*?(?=\n|$)', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text).strip()

    words = text.split()
    if not words or total_duration <= 1:
        print("  ⚠️  SRT: sin texto o duración insuficiente", flush=True)
        return False

    # Chunks de 6 palabras → ritmo natural para Shorts
    CHUNK_SIZE = 6
    chunks = [' '.join(words[i:i+CHUNK_SIZE]) for i in range(0, len(words), CHUNK_SIZE)]
    chunks = [c.strip() for c in chunks if c.strip()]

    if not chunks:
        return False

    time_per_chunk = total_duration / len(chunks)

    def fmt(secs: float) -> str:
        h = int(secs // 3600)
        m = int((secs % 3600) // 60)
        s = int(secs % 60)
        ms = int((secs % 1) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    with open(output_path, 'w', encoding='utf-8') as f:
        for i, chunk in enumerate(chunks):
            start = i * time_per_chunk
            end   = min((i + 1) * time_per_chunk, total_duration - 0.05)
            f.write(f"{i + 1}\n{fmt(start)} --> {fmt(end)}\n{chunk}\n\n")

    print(f"  ✅ SRT: {len(chunks)} subtítulos × {time_per_chunk:.1f}s", flush=True)
    return True


def burn_subtitles(video_path: str, srt_path: str, output_path: str) -> bool:
    """Quema subtítulos estilo TikTok en el video (blanco, negrita, outline negro)."""
    # Escapar ruta para el filtro de ffmpeg (barras en Windows)
    srt_escaped = srt_path.replace('\\', '/').replace(':', r'\:')
    style = (
        "FontName=Arial,"
        "FontSize=24,"
        "PrimaryColour=&H00FFFFFF,"
        "OutlineColour=&H00000000,"
        "BackColour=&H60000000,"
        "Bold=1,"
        "Outline=2,"
        "Shadow=1,"
        "Alignment=2,"
        "MarginV=80"
    )
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vf", f"subtitles='{srt_escaped}':force_style='{style}'",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]
    print("  🔤 Quemando subtítulos en el video…", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    if r.returncode != 0:
        print(f"  ⚠️  Subtítulos fallaron (se entrega sin ellos):\n{r.stderr[-400:]}", flush=True)
        return False
    size_kb = os.path.getsize(output_path) // 1024
    print(f"  ✅ Video con subtítulos: {output_path} ({size_kb}KB)", flush=True)
    return True


def upload_file(file_path: str) -> str:
    """
    Sube archivo usando curl (streaming — no carga el archivo en RAM de Python).
    Orden de preferencia:
      1. Litterbox catbox.moe  — URL directa ← PREFERIDO
      2. tmpfiles.org/dl/      — URL directa
      3. uguu.se               — URL directa
      4. GoFile                — URL de página (último recurso)
    """
    filename = os.path.basename(file_path)
    size_mb  = os.path.getsize(file_path) / 1024 / 1024
    print(f"  📤 Subiendo {filename} ({size_mb:.1f} MB) con curl...", flush=True)

    def run_curl(cmd: list, timeout: int = 240) -> str:
        """Ejecuta curl y devuelve stdout; devuelve '' si falla."""
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            return r.stdout.strip()
        except Exception as e:
            print(f"    curl error: {e}", flush=True)
            return ""

    # ── 1. Litterbox catbox.moe ───────────────────────────────────────────────
    try:
        out = run_curl([
            "curl", "-s", "--max-time", "240",
            "-F", "reqtype=fileupload",
            "-F", "time=72h",
            "-F", f"fileToUpload=@{file_path};type=video/mp4",
            "https://litterbox.catbox.moe/resources/internals/api.php",
        ])
        if out.startswith("http"):
            print(f"  ✅ catbox.moe: {out}", flush=True)
            return out
        print(f"  ⚠️  catbox.moe respuesta inesperada: {out[:120]}", flush=True)
    except Exception as e:
        print(f"  ⚠️  catbox.moe falló: {e}", flush=True)

    # ── 2. tmpfiles.org ───────────────────────────────────────────────────────
    try:
        out = run_curl([
            "curl", "-s", "--max-time", "180",
            "-F", f"file=@{file_path}",
            "https://tmpfiles.org/api/v1/upload",
        ])
        tj  = json.loads(out) if out else {}
        url = tj.get("data", {}).get("url", "")
        if url.startswith("http"):
            url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/")
            print(f"  ✅ tmpfiles.org: {url}", flush=True)
            return url
    except Exception as e:
        print(f"  ⚠️  tmpfiles.org falló: {e}", flush=True)

    # ── 3. uguu.se ────────────────────────────────────────────────────────────
    try:
        out = run_curl([
            "curl", "-s", "--max-time", "180",
            "-F", f"files[]=@{file_path}",
            "https://uguu.se/upload",
        ])
        uj  = json.loads(out) if out else {}
        url = uj.get("files", [{}])[0].get("url", "")
        if url.startswith("http"):
            print(f"  ✅ uguu.se: {url}", flush=True)
            return url
    except Exception as e:
        print(f"  ⚠️  uguu.se falló: {e}", flush=True)

    # ── 4. GoFile ─────────────────────────────────────────────────────────────
    try:
        with urllib.request.urlopen("https://api.gofile.io/servers", timeout=10) as r:
            srv = json.loads(r.read().decode())["data"]["servers"][0]["name"]
        out = run_curl([
            "curl", "-s", "--max-time", "180",
            "-F", f"file=@{file_path}",
            f"https://{srv}.gofile.io/contents/uploadFile",
        ])
        gf  = json.loads(out) if out else {}
        url = gf.get("data", {}).get("downloadPage", "")
        if url.startswith("http"):
            print(f"  ✅ GoFile (página): {url}", flush=True)
            return url
    except Exception as e:
        print(f"  ⚠️  GoFile falló: {e}", flush=True)

    raise Exception("Todos los servicios de upload fallaron")


def main():
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    else:
        raw = sys.stdin.read().strip()

    issue_title, issue_body = resolve_issue_context()
    if issue_body:
        raw = issue_body

    # Extraer PARENT_ISSUE_ID inyectado por el Director en la descripción del sub-issue.
    # Esto permite que post_parent_update() notifique a Studio aunque el Director
    # ya haya cerrado su issue (agente corre como proceso Paperclip independiente).
    # Soportar ambos formatos: texto plano (nuevo) y HTML comment (legacy)
    _parent_match = re.search(r'PARENT_ISSUE_ID:([^\n\s>]+)', raw)
    if _parent_match:
        os.environ['PAPERCLIP_PARENT_ISSUE_ID'] = _parent_match.group(1).strip()
        raw = raw.replace(_parent_match.group(0), '').strip()
        raw = re.sub(r'<!--[^>]*-->', '', raw).strip()
        print(f"  🔗 Parent issue ID detectado: {os.environ['PAPERCLIP_PARENT_ISSUE_ID'][:12]}…", flush=True)

    post_issue_comment("🎬 Ensamblando video MP4 9:16…")

    # Parsear input — acepta JSON o texto libre con URLs
    data = {}
    m = re.search(r"\{[\s\S]*\}", raw)
    if m:
        try:
            data = json.loads(m.group(0))
        except Exception:
            pass

    video_clips     = data.get("video_clips") or []
    image_urls      = data.get("image_urls")  or extract_image_urls(raw)
    audio_path      = data.get("audio_path", "")
    audio_url       = data.get("audio_url", "") or extract_audio_url(raw)
    narration_text  = data.get("narration_text", "")

    print(f"🎞️  video_clips recibidos: {len(video_clips)}", flush=True)
    for u in video_clips[:6]:
        print(f"   • {u[:100]}", flush=True)
    print(f"🖼️  image_urls recibidas: {len(image_urls)}", flush=True)
    print(f"🎙️  audio_path: '{audio_path}'", flush=True)
    print(f"🔗 audio_url:  '{audio_url[:80] if audio_url else ''}'", flush=True)

    timestamp = int(time.time())
    tmp_dir   = f"/tmp/video_{timestamp}"
    os.makedirs(tmp_dir, exist_ok=True)

    # ── Resolver audio ────────────────────────────────────────
    if audio_path and os.path.exists(audio_path):
        print(f"🎙️  Audio local: {audio_path}", flush=True)
    elif audio_url:
        print(f"🎙️  Descargando audio desde URL: {audio_url[:60]}", flush=True)
        downloaded = f"{tmp_dir}/narration.mp3"
        if download_audio(audio_url, downloaded):
            audio_path = downloaded
        else:
            audio_path = ""
    else:
        mp3s = sorted(glob.glob("/tmp/narration_*.mp3"), key=os.path.getmtime, reverse=True)
        audio_path = mp3s[0] if mp3s else ""
        if audio_path:
            print(f"🎙️  Audio encontrado en /tmp: {audio_path}", flush=True)
        else:
            print("🎙️  Sin audio — video mudo", flush=True)

    output_path = f"{tmp_dir}/video.mp4"
    total_dur   = 0.0
    scenes      = 0

    # ── MODO A: clips animados (Higgsfield DOP) ───────────────
    if video_clips:
        print(f"\n🎞️  MODO: clips animados ({len(video_clips)} clips)", flush=True)
        clip_paths = []
        for i, url in enumerate(video_clips):
            path = f"{tmp_dir}/clip_{i+1:02d}.mp4"
            print(f"  📥 Clip {i+1}/{len(video_clips)}: {url[:80]}", flush=True)
            if download_video_clip(url, path):
                clip_paths.append(path)

        if not clip_paths:
            print("⚠️  No se descargaron clips — cayendo a modo imágenes", flush=True)
            video_clips = []  # forzar fallback

        if clip_paths:
            ok, total_dur = assemble_from_clips(clip_paths, audio_path, output_path)
            scenes = len(clip_paths)
            if not ok:
                print("⚠️  assemble_from_clips falló — cayendo a modo imágenes", flush=True)
                video_clips = []  # forzar fallback

    # ── MODO B: imágenes estáticas (slideshow) ────────────────
    if not video_clips:
        print(f"\n🖼️  MODO: imágenes estáticas ({len(image_urls)} URLs)", flush=True)
        if not image_urls:
            print("ERROR: sin imágenes ni clips para ensamblar", file=sys.stderr)
            sys.exit(1)

        image_paths = []
        for i, url in enumerate(image_urls):
            from urllib.parse import urlparse as _urlparse
            _url_path = _urlparse(url).path
            _basename = _url_path.rsplit("/", 1)[-1]
            ext = _basename.rsplit(".", 1)[-1][:8] if "." in _basename else "jpg"
            if ext.lower() not in {"jpg", "jpeg", "png", "webp", "avif", "gif", "bmp"}:
                ext = "jpg"
            path = f"{tmp_dir}/scene_{i+1:02d}.{ext}"
            print(f"  📥 Imagen {i+1}/{len(image_urls)} [{ext}]: {url[:80]}", flush=True)
            if download_image(url, path):
                image_paths.append(path)

        if not image_paths:
            print("ERROR: no se pudieron descargar imágenes", file=sys.stderr)
            sys.exit(1)

        audio_dur = get_audio_duration(audio_path) if audio_path else 0.0
        if audio_dur and len(image_paths):
            scene_duration = min(max(4.0, audio_dur / len(image_paths)), 20.0)
        else:
            scene_duration = 5.0
        total_dur = scene_duration * len(image_paths)
        scenes    = len(image_paths)
        print(f"  ⏱️  {scenes} escenas × {scene_duration:.1f}s = {total_dur:.0f}s total", flush=True)

        ok = assemble_video(image_paths, audio_path, output_path, scene_duration)
        if not ok:
            print("ERROR: ffmpeg falló", file=sys.stderr)
            sys.exit(1)

    if not os.path.exists(output_path):
        print("ERROR: output_path no existe tras ensamblado", file=sys.stderr)
        sys.exit(1)

    file_size = os.path.getsize(output_path)
    print(f"📦 Tamaño del video: {file_size/1024/1024:.1f} MB", flush=True)

    print("📤 Subiendo video...", flush=True)
    try:
        video_url = upload_file(output_path)
        print(f"  ✅ Video: {video_url}", flush=True)
    except Exception as e:
        print(f"  ⚠️  Upload falló: {e}", flush=True)
        video_url = ""

    mode_label = "animado (DOP)" if data.get("video_clips") else "slideshow"
    result = json.dumps({
        "video_url":    video_url,
        "mode":         mode_label,
        "scenes":       scenes,
        "duration_s":   round(total_dur),
        "file_size_mb": round(file_size / 1024 / 1024, 1),
        "has_audio":    bool(audio_path),
    }, ensure_ascii=False, indent=2)

    print(result)
    _va_output = (
        "🎬 **Video listo**\n\n"
        + (f"📥 [Descargar MP4]({video_url})\n" if video_url else "")
        + (f"**FINAL_VIDEO_URL:** {video_url}\n" if video_url else "")
        + f"🎞️ Modo: {mode_label} — {scenes} escenas — {round(total_dur)}s\n"
        f"📦 {file_size/1024/1024:.1f} MB\n"
        f"{'🎙️ Con voz en off' if audio_path else '⚠️ Sin audio'}\n\n"
        "Listo para TikTok, Reels y YouTube Shorts. 🚀"
    )
    post_issue_result(_va_output)
    # Notificar al issue padre (Director) para que Studio muestre el video final
    # aunque el Director ya haya cerrado su issue
    post_parent_update("video_assembler", _va_output)


if __name__ == "__main__":
    main()
