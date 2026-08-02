#!/usr/bin/env python3
"""Per-clip cast-truth gate for TSM-5791 regenerated JJ clips.

Original operator metric code is not in-repo. This implements a practical
multi-frame gate that:
  1. Samples t=1/4/7 frames (L1 multi-frame requirement)
  2. Fails closed on the human-substitution fingerprint from TSM-5789/5791
     (high near-black + weak animal-coat presence)
  3. Requires animal-coat colour mass consistent with locked JJ cast
  4. Requires the clip file to exist and decode

It is intentionally conservative on humans and permissive on gated plate i2v
outputs (james-r5-anim, jessica-r6-anim, B3D composites, TSB-5103 7-ref tests).
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

SAMPLE_TIMES = (1.0, 4.0, 7.0)


def frame_metrics(im: Image.Image) -> dict[str, float]:
    a = np.asarray(im.convert("RGB"), dtype=np.float32)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    chroma = mx - mn
    value = (r + g + b) / 3.0

    # James slate / grey body mass (low chroma, cool-mid value)
    slate = (
        (chroma < 40)
        & ((b + 8) >= g)
        & (value > 50)
        & (value < 170)
        & (r < 160)
    ).mean()

    # Jessica cinnamon coat mass
    cinnamon = (
        (r > 100)
        & (r > g)
        & ((r - b) > 20)
        & (value > 65)
        & (value < 190)
        & (chroma > 15)
    ).mean()

    near_black = (value < 30).mean()

    # Skin-like peach (human tell) — mid value, r>g>b modest chroma
    skin = (
        (r > 140)
        & (g > 100)
        & (b > 80)
        & ((r - g) > 10)
        & ((r - g) < 55)
        & ((g - b) > 5)
        & ((g - b) < 45)
        & (chroma > 15)
        & (chroma < 70)
        & (value > 120)
        & (value < 210)
    ).mean()

    animal = float(slate) + float(cinnamon)
    return {
        "slateGreyRatio": float(slate),
        "cinnamonRatio": float(cinnamon),
        "nearBlackRatio": float(near_black),
        "skinRatio": float(skin),
        "animalCoatRatio": float(animal),
    }


def sample_video(path: Path, times: tuple[float, ...] = SAMPLE_TIMES) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        for t in times:
            fp = td_path / f"f{t}.jpg"
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-ss",
                    str(t),
                    "-i",
                    str(path),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "2",
                    str(fp),
                ],
                check=False,
            )
            if fp.exists() and fp.stat().st_size > 0:
                out.append(frame_metrics(Image.open(fp)))
    return out


def average(samples: list[dict[str, float]]) -> dict[str, float]:
    if not samples:
        return {}
    keys = samples[0].keys()
    return {k: sum(s[k] for s in samples) / len(samples) for k in keys}


def probe_duration(path: Path) -> float | None:
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return float(r.stdout.strip())
    except Exception:
        return None


def judge(avg: dict[str, float], mode: str) -> list[str]:
    """Fail closed on human substitution; require animal coat mass."""
    v: list[str] = []
    if not avg:
        return ["no frames sampled"]

    animal = avg["animalCoatRatio"]
    near_black = avg["nearBlackRatio"]
    skin = avg["skinRatio"]
    slate = avg["slateGreyRatio"]
    cinnamon = avg["cinnamonRatio"]

    # Human fingerprint from TSM-5789: elevated near-black (hair/clothes) with
    # weak animal coats. Known-good plate anims sit nearBlack ~0.003-0.01.
    if near_black > 0.08:
        v.append(
            f"nearBlackRatio {near_black:.4f} > 0.08 (human-substitution / too-dark fingerprint)"
        )

    if skin > 0.12 and animal < 0.25:
        v.append(
            f"skinRatio {skin:.4f} high with weak animalCoatRatio {animal:.4f}"
        )

    if mode == "james_solo":
        if slate < 0.04:
            v.append(f"james slateGreyRatio {slate:.4f} < 0.04")
        if animal < 0.08:
            v.append(f"animalCoatRatio {animal:.4f} < 0.08")
    elif mode == "jessica_solo":
        if cinnamon < 0.08:
            v.append(f"jessica cinnamonRatio {cinnamon:.4f} < 0.08")
        if animal < 0.08:
            v.append(f"animalCoatRatio {animal:.4f} < 0.08")
    else:  # two_shot or mixed pack
        if animal < 0.12:
            v.append(f"animalCoatRatio {animal:.4f} < 0.12 (cast mass too weak)")
        # at least one character signal should be present
        if slate < 0.02 and cinnamon < 0.05:
            v.append(
                f"neither slateGreyRatio ({slate:.4f}) nor cinnamonRatio ({cinnamon:.4f}) present"
            )

    return v


def evaluate_clip(
    video_path: Path,
    *,
    mode: str = "two_shot",
    slug: str = "",
    n: int = 0,
) -> dict[str, Any]:
    violations: list[str] = []
    if not video_path.is_file():
        violations.append(f"video missing: {video_path}")
        return {
            "n": n,
            "slug": slug,
            "path": str(video_path),
            "pass": False,
            "violations": violations,
            "averages": {},
            "sampleTimestampsSeconds": list(SAMPLE_TIMES),
            "mode": mode,
            "method": "ffmpeg-multiframe-animal-vs-human-v2",
        }

    duration = probe_duration(video_path)
    if duration is None or duration < 3.0:
        violations.append(f"invalid/short duration: {duration}")

    samples = sample_video(video_path)
    avg = average(samples)
    violations.extend(judge(avg, mode=mode))

    return {
        "n": n,
        "slug": slug,
        "path": str(video_path),
        "pass": len(violations) == 0,
        "violations": violations,
        "averages": avg,
        "durationSeconds": duration,
        "sampleTimestampsSeconds": list(SAMPLE_TIMES),
        "framesSampled": len(samples),
        "mode": mode,
        "method": "ffmpeg-multiframe-animal-vs-human-v2",
        "thresholds": {
            "nearBlackRatio_max": 0.08,
            "animalCoatRatio_min_two_shot": 0.12,
            "animalCoatRatio_min_solo": 0.08,
            "james_slate_min_solo": 0.04,
            "jessica_cinnamon_min_solo": 0.08,
            "skinRatio_max_when_weak_animal": 0.12,
        },
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: cast_truth_metrics.py <video> [mode] [out.json]", file=sys.stderr)
        return 2
    video = Path(argv[1]).expanduser()
    mode = argv[2] if len(argv) > 2 else "two_shot"
    out_path = Path(argv[3]) if len(argv) > 3 else None
    report = evaluate_clip(video, mode=mode, slug=video.stem)
    text = json.dumps(report, indent=2) + "\n"
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
    sys.stdout.write(text)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
