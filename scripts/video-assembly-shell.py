#!/usr/bin/env python3
"""Mini-first, zero-LLM media assembly for the TSM RoutineOps handler.

This replaces the old Studio-local ffmpeg stage. It stages just the manifest's
media inputs into a self-contained job, sends that job through mini-render.sh,
and brings the MP4, cut map, metrics, and QA frames back to the requested
output directory. There is deliberately no local ffmpeg fallback: a missing
Mini is a visible operational blocker, not a reason to consume Studio CPU.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


MINI_RENDER = Path.home() / "scripts" / "mini-render.sh"


RUNNER = r'''#!/usr/bin/env python3
import argparse, hashlib, json, subprocess, time
from pathlib import Path

def run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(result.stderr[-2000:] or "ffmpeg failed")

def duration(path):
    return float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1", str(path)], text=True).strip())

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def geometry(path):
    """Return source video geometry when ffprobe can read it.

    This makes padded provider outputs (for example 1920x1088 labelled
    "1080p") visible in the zero-LLM assembly evidence before the standard
    scale/crop delivery normalization is applied.
    """
    try:
        raw = subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", str(path),
        ], text=True)
        streams = json.loads(raw).get("streams") or []
        stream = streams[0] if streams else {}
        width, height = stream.get("width"), stream.get("height")
        if isinstance(width, int) and isinstance(height, int):
            return {"width": width, "height": height}
    except Exception:
        pass
    return None

parser = argparse.ArgumentParser()
parser.add_argument("--manifest", required=True)
parser.add_argument("--out-dir", required=True)
args = parser.parse_args()
started = time.time()
manifest_path = Path(args.manifest).resolve()
out = Path(args.out_dir).resolve()
out.mkdir(parents=True, exist_ok=True)
manifest = json.loads(manifest_path.read_text())
width, height, fps = int(manifest.get("width", 1920)), int(manifest.get("height", 1080)), int(manifest.get("fps", 30))
clips = manifest.get("clips") or []
if not clips:
    raise SystemExit("manifest.clips is empty")
work = out / "_work"
work.mkdir(exist_ok=True)
parts, plan = [], []
vf = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},fps={fps},setsar=1,format=yuv420p"
for index, clip in enumerate(clips):
    source = (manifest_path.parent / clip["src"]).resolve()
    if not source.is_file():
        raise SystemExit(f"missing clip: {source}")
    target = work / f"part-{index:03d}.mp4"
    if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
        seconds = float(clip.get("duration") or 3)
        run(["ffmpeg", "-y", "-loop", "1", "-i", str(source), "-t", f"{seconds:.3f}", "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", str(target)])
    else:
        command = ["ffmpeg", "-y"]
        if clip.get("in") is not None:
            command += ["-ss", f"{float(clip['in']):.3f}"]
        if clip.get("out") is not None:
            length = float(clip["out"]) - float(clip.get("in") or 0)
            command += ["-t", f"{length:.3f}"]
        command += ["-i", str(source), "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", str(target)]
        run(command)
    seconds = duration(target)
    parts.append(target)
    plan.append({
        "index": index,
        "src": clip["src"],
        "duration_s": seconds,
        "sha256": digest(source),
        "source_geometry": geometry(source),
        "delivery_geometry": {"width": width, "height": height},
        "normalization": {
            "filter": vf,
            "padded_1080p_policy": "crop to the requested delivery height; preserve the source hash in this cut map",
        },
    })
concat = work / "concat.txt"
concat.write_text("".join(f"file '{part.resolve()}'\n" for part in parts))
timeline = work / "timeline.mp4"
run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(timeline)])
final = out / "final.mp4"
audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
audio_src = audio.get("src")
if audio_src:
    source = (manifest_path.parent / audio_src).resolve()
    if not source.is_file() and not audio.get("optional", False):
        raise SystemExit(f"missing audio: {source}")
    if source.is_file():
        run(["ffmpeg", "-y", "-i", str(timeline), "-i", str(source), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(final)])
    else:
        run(["ffmpeg", "-y", "-i", str(timeline), "-c", "copy", "-movflags", "+faststart", str(final)])
else:
    run(["ffmpeg", "-y", "-i", str(timeline), "-c", "copy", "-movflags", "+faststart", str(final)])
total = duration(final)
qa = out / "qa-frames"
qa.mkdir(exist_ok=True)
for label, at in (("start", .1), ("mid", max(.1, total / 2)), ("end", max(.1, total - .15))):
    run(["ffmpeg", "-y", "-ss", f"{at:.3f}", "-i", str(final), "-frames:v", "1", str(qa / f"{label}.png")])
metrics = {"stage": "assembly", "handler": "scripts/video-assembly-shell.py", "llm_tokens": 0, "llm_input_tokens": 0, "llm_output_tokens": 0, "title": manifest.get("title"), "width": width, "height": height, "fps": fps, "clip_count": len(parts), "duration_s": total, "final_mp4": str(final), "final_sha256": digest(final), "final_bytes": final.stat().st_size, "plan": plan, "qa_frames": [str(path) for path in sorted(qa.glob("*.png"))], "elapsed_s": round(time.time() - started, 3)}
(out / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
(out / "cut-map.json").write_text(json.dumps({"method": "manifest-hard-cut", "segments": plan, "final_sha256": metrics["final_sha256"], "duration_s": total}, indent=2) + "\n")
'''


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolved(path_text: str, manifest: Path) -> Path:
    candidate = Path(path_text).expanduser()
    return candidate if candidate.is_absolute() else (manifest.parent / candidate).resolve()


def stage_file(source: Path, inputs: Path, ordinal: int) -> str:
    if not source.is_file():
        raise SystemExit(f"missing input: {source}")
    target = inputs / f"{ordinal:03d}-{source.name}"
    shutil.copy2(source, target)
    return str(target.relative_to(inputs.parent))


def build_job(manifest_path: Path, job: Path) -> None:
    source_manifest = json.loads(manifest_path.read_text())
    clips = source_manifest.get("clips") or []
    if not clips:
        raise SystemExit("manifest.clips is empty")
    inputs = job / "inputs"
    inputs.mkdir(parents=True)
    staged_clips = []
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict) or not isinstance(clip.get("src"), str):
            raise SystemExit(f"invalid manifest clip at index {index}")
        staged = dict(clip)
        staged["src"] = stage_file(resolved(clip["src"], manifest_path), inputs, index)
        staged_clips.append(staged)
    source_manifest["clips"] = staged_clips
    audio = source_manifest.get("audio")
    if isinstance(audio, dict) and isinstance(audio.get("src"), str):
        staged_audio = dict(audio)
        source = resolved(audio["src"], manifest_path)
        if source.is_file():
            staged_audio["src"] = stage_file(source, inputs, len(staged_clips))
        source_manifest["audio"] = staged_audio
    (job / "assembly-manifest.json").write_text(json.dumps(source_manifest, indent=2) + "\n")
    (job / "mini-assembly.py").write_text(RUNNER)
    render = job / "render.sh"
    render.write_text("#!/usr/bin/env bash\nset -euo pipefail\nexport PATH=/opt/homebrew/bin:$PATH\npython3 mini-assembly.py --manifest assembly-manifest.json --out-dir rendered\n")
    render.chmod(0o755)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    manifest = Path(args.manifest).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    if not manifest.is_file():
        raise SystemExit(f"missing manifest: {manifest}")
    if not MINI_RENDER.is_file():
        raise SystemExit(f"Mini renderer is unavailable: {MINI_RENDER}")
    out_dir.mkdir(parents=True, exist_ok=True)
    job = Path(tempfile.mkdtemp(prefix="mini-assembly-", dir=str(out_dir.parent)))
    build_job(manifest, job)
    result = subprocess.run([str(MINI_RENDER), str(job)], capture_output=True, text=True, timeout=840)
    sys.stderr.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)
    rendered = job / "rendered"
    if not (rendered / "final.mp4").is_file():
        raise SystemExit("Mini job completed without final.mp4")
    for child in rendered.iterdir():
        destination = out_dir / child.name
        if child.is_dir():
            shutil.copytree(child, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(child, destination)
    metrics_path = out_dir / "metrics.json"
    metrics = json.loads(metrics_path.read_text()) if metrics_path.is_file() else {}
    final = out_dir / "final.mp4"
    metrics.update({
        "renderer_host": os.environ.get("MINI", "mac-mini.tail3ef4e9.ts.net"),
        "renderer_route": "mini-render.sh",
        "llm_tokens": 0,
        "final_mp4": str(final),
        "final_sha256": sha256(final),
        "final_bytes": final.stat().st_size,
    })
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
