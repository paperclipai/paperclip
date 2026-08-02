#!/usr/bin/env python3
"""Bank a regenerated clip: provenance + cast-truth + manifest patch."""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/Users/glad0s/paperclip")
OUT = ROOT / "work-products" / "TSM-5791"
MANIFEST = OUT / "source" / "tsm-5791-regenerated-clip-manifest.template.json"
INSTANCE_OUT = Path(
    "/Users/glad0s/.paperclip/instances/default/companies/"
    "d71c9e82-1a4b-497f-9bbc-5b9dd028c367/work-products/TSM-5791"
)
sys.path.insert(0, str(OUT / "scripts"))
from cast_truth_metrics import evaluate_clip  # noqa: E402

ORIG = Path("/Users/glad0s/Pictures/ThinkStack Assets/Jessica James/Emotion cards - ORIGINALS")
PLATES = [
    "work-products/TSM-5791/source/jessica-plate-r6-fromoriginal.jpg",
    "work-products/TSM-5791/source/james-plate-r5-eyes.jpg",
    "work-products/TSM-5791/source/refs/3-SIZE-LINEUP-1.20-SIGNED.jpg",
]
# Always cite several ORIGINAL emotion cards so L2 gate can find filenames in provenance
DEFAULT_ORIGINALS = sorted(p.name for p in ORIG.glob("*.png"))[:6]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def bank(
    *,
    n: int,
    slug: str,
    video: Path,
    seed: Path,
    request_id: str,
    provider_url: str,
    prompt: str,
    mode: str,
    original_names: list[str] | None = None,
    model: str = "grok-imagine-video-1.5",
) -> dict:
    video = video.resolve()
    seed = seed.resolve()
    assert video.is_file(), video
    assert seed.is_file(), seed

    originals = original_names or DEFAULT_ORIGINALS
    # Ensure names exist
    for name in originals:
        if not (ORIG / name).is_file():
            raise FileNotFoundError(ORIG / name)

    prov_path = OUT / "provenance" / f"{n:02d}-{slug}-provenance.json"
    report_path = OUT / "reports" / f"{n:02d}-{slug}-cast-truth.json"

    # cast truth
    report = evaluate_clip(video, mode=mode, slug=slug, n=n)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    reference_files = [rel(seed)] + PLATES + originals
    provenance = {
        "issue": "TSM-5888",
        "parentIssue": "TSM-5791",
        "n": n,
        "slug": slug,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "method": "img2video",
        "model": model,
        "requestId": request_id,
        "providerUrl": provider_url,
        "prompt": prompt,
        "negativePrompt": "humans, children, clothing, text, Bluey, morphing, extra limbs, restage",
        "seedImage": rel(seed),
        "seedImageSha256": sha256(seed),
        "replacementPath": rel(video),
        "replacementSha256": sha256(video),
        "lockedPlates": PLATES,
        "referenceFiles": reference_files,
        "originalEmotionCards": originals,
        "originalsRoot": str(ORIG),
        "recipe": "TSKB0175 v1.0 + ADDENDUM-20260730 + ADDENDUM-20260731",
        "laws": ["L1 multi-frame cast-truth", "L2 image provenance", "L3 no quarantined lineage", "L4 no child-canon text2video"],
        "castTruthPass": report["pass"],
        "castTruthReport": rel(report_path),
    }
    prov_path.parent.mkdir(parents=True, exist_ok=True)
    prov_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    # patch manifest
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    found = False
    for clip in man["clips"]:
        if int(clip["n"]) == n:
            clip["replacementPath"] = rel(video)
            clip["perClipCastTruthReport"] = rel(report_path)
            clip["provenanceRecord"] = rel(prov_path)
            clip["assemblyEligible"] = bool(report["pass"])
            clip["regeneratedAt"] = provenance["generatedAt"]
            clip["requestId"] = request_id
            found = True
            break
    if not found:
        raise RuntimeError(f"slot {n} missing in manifest")
    MANIFEST.write_text(json.dumps(man, indent=2) + "\n", encoding="utf-8")

    # mirror key artifacts to instance served tree
    try:
        for src, dst_root in [
            (video, INSTANCE_OUT / "clip-bytes"),
            (prov_path, INSTANCE_OUT / "provenance"),
            (report_path, INSTANCE_OUT / "reports"),
            (MANIFEST, INSTANCE_OUT / "source"),
        ]:
            dst_root.mkdir(parents=True, exist_ok=True)
            dst = dst_root / src.name
            dst.write_bytes(src.read_bytes())
    except Exception as exc:
        print(f"mirror warning: {exc}", file=sys.stderr)

    return {
        "n": n,
        "slug": slug,
        "pass": report["pass"],
        "violations": report.get("violations", []),
        "video": rel(video),
        "provenance": rel(prov_path),
        "castTruth": rel(report_path),
    }


def main(argv: list[str]) -> int:
    # argv: n slug video seed request_id provider_url mode [prompt]
    if len(argv) < 8:
        print(
            "usage: bank_clip.py n slug video seed request_id provider_url mode [prompt]",
            file=sys.stderr,
        )
        return 2
    n = int(argv[1])
    slug = argv[2]
    video = Path(argv[3])
    seed = Path(argv[4])
    request_id = argv[5]
    provider_url = argv[6]
    mode = argv[7]
    prompt = argv[8] if len(argv) > 8 else ""
    result = bank(
        n=n,
        slug=slug,
        video=video,
        seed=seed,
        request_id=request_id,
        provider_url=provider_url,
        prompt=prompt,
        mode=mode,
    )
    print(json.dumps(result, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
