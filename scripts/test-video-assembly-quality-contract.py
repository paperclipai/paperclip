#!/usr/bin/env python3
"""Fast fixtures for Cashflow Compass's pre-Mini quality contract.

No media, Mini connection, or LLM is required.  These are contract fixtures:
they make the known EP-02 rejection classes fail before a render is staged.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).with_name("video-assembly-shell.py")
spec = importlib.util.spec_from_file_location("video_assembly_shell", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def valid_manifest() -> dict:
    return {
        "channel": "cashflow-compass",
        "clips": [
            {
                "src": "intro.mp4",
                "visualFingerprint": "intro-unique",
                "role": "title-card",
                "motionStyle": "native-build",
            },
            {
                "src": "numbers.mp4",
                "visualFingerprint": "numbers-unique",
                "role": "data-slide",
                "motionStyle": "progressive-build",
            },
        ],
        "qualityContract": {
            "version": 1,
            "audio": {
                "playbackRate": 1,
                "allSentencesAligned": True,
                "finalSentenceComplete": True,
                "alignmentEvidence": "qa/alignment.json",
            },
            "titleCard": {
                "episodeLabel": "EP-02",
                "lowerThirdExcluded": True,
                "approvedBrandFont": True,
                "episodePillCentered": True,
            },
            "motion": {
                "noKenBurnsOnTextOrDataSlides": True,
                "fixedAnchorsVerified": True,
                "nativeBuildsOrApprovedTransitions": True,
            },
            "broll": {"noVisibleBlackOrJumpyJoins": True},
            "numericExamples": [
                {
                    "spokenClaim": "A $100,000 grant can have withholding before shares reach you.",
                    "onScreenVisual": "grant-to-withholding-to-remainder",
                    "dataCite": "internal-example-v1",
                    "readableAt1080p": True,
                }
            ],
            "leadMagnetCta": {
                "approvedAssetShown": True,
                "useCaseShown": "Use the checklist before your vest date.",
                "assetEvidence": "assets/cc-checklist.pdf",
            },
        },
    }


def expect_failure(mutator, phrase: str) -> None:
    manifest = valid_manifest()
    mutator(manifest)
    report = module.validate_cc_quality_contract(manifest)
    assert report["status"] == "failed", report
    assert any(phrase in finding for finding in report["findings"]), report


def main() -> int:
    report = module.validate_cc_quality_contract(valid_manifest())
    assert report["status"] == "passed", report
    expect_failure(lambda m: m["qualityContract"]["audio"].update({"playbackRate": 2}), "playbackRate")
    expect_failure(lambda m: m["clips"][0].update({"src": "money-cyclone.mp4"}), "banned money/cyclone")
    expect_failure(lambda m: m["clips"][1].update({"visualFingerprint": "intro-unique"}), "repeats visualFingerprint")
    expect_failure(lambda m: m["clips"][1].update({"motionStyle": "ken-burns"}), "banned ken-burns")
    expect_failure(lambda m: m["qualityContract"]["numericExamples"][0].pop("dataCite"), "dataCite")
    expect_failure(lambda m: m["qualityContract"]["titleCard"].update({"lowerThirdExcluded": False}), "lowerThirdExcluded")
    print("PASS: Cashflow Compass quality-contract fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
