#!/usr/bin/env python3
"""Shared judge-lane policy for the TSBC benchmark harness."""

from __future__ import annotations

import copy

DEFAULT_JUDGE_ID = "spark-medium"
OPUS_RESERVE_JUDGE_ID = "claude-opus"
SPARK_MODEL_ARG = "gpt-5.3-codex-spark"
SPARK_REASONING_EFFORT = "medium"
DRIFT_MEAN_ABS_DELTA_REVERT_THRESHOLD = 0.05
SPOT_CHECK_ABS_DELTA_OPUS_THRESHOLD = 0.10

TSBC_1642_MEDIUM_CALIBRATION_RUN_ID = "tsbc-1642-judge-calibration-20260731-021743"
TSBC_1642_HIGH_CALIBRATION_RUN_ID = "tsbc-1642-judge-calibration-high-20260731-022117"
TSBC_1642_CALIBRATION_SET_SHA256 = "6f15bbae0a0f5471a64f50703368bebc79c3bb449bbda6b4fe1f86ebbfce1fdf"

DEFAULT_JUDGE = {
    "id": DEFAULT_JUDGE_ID,
    "adapter": "codex",
    "model_arg": SPARK_MODEL_ARG,
    "reasoning_effort": SPARK_REASONING_EFFORT,
    "label": "Codex GPT-5.3 Spark (medium) blind judge",
    "lane": "codex",
}

OPUS_RESERVE_JUDGE = {
    "id": OPUS_RESERVE_JUDGE_ID,
    "adapter": "claude",
    "model_arg": "opus",
    "label": "Claude Opus reserve judge",
    "lane": "claude",
}

RESERVE_REASONS = [
    "blind_holdout",
    "verdict_deciding_cell",
    "primary_flip",
    "adoption_gate",
    "reference_fidelity",
    "spot_check_disagreement_gt_0_10",
]

JUDGE_ALIASES = {
    DEFAULT_JUDGE_ID: DEFAULT_JUDGE,
    "spark": DEFAULT_JUDGE,
    "spark-medium-as-judge": DEFAULT_JUDGE,
    OPUS_RESERVE_JUDGE_ID: OPUS_RESERVE_JUDGE,
    "opus": OPUS_RESERVE_JUDGE,
}


def clone_judge(row: dict) -> dict:
    return copy.deepcopy(row)


def named_judge(judge_id: str | None) -> dict | None:
    if not judge_id:
        return None
    return clone_judge(JUDGE_ALIASES.get(str(judge_id).strip()))


def default_judge() -> dict:
    return clone_judge(DEFAULT_JUDGE)


def opus_reserve_judge() -> dict:
    return clone_judge(OPUS_RESERVE_JUDGE)


def is_opus_reserve_reason(reason: str | None) -> bool:
    return str(reason or "").strip() in RESERVE_REASONS


def calibration_summary() -> dict:
    return {
        "sourceIssue": "TSBC-1642",
        "mediumRunId": TSBC_1642_MEDIUM_CALIBRATION_RUN_ID,
        "highRunId": TSBC_1642_HIGH_CALIBRATION_RUN_ID,
        "calibrationSetSha256": TSBC_1642_CALIBRATION_SET_SHA256,
        "mediumMeanAbsDelta": 0.038642857142857145,
        "mediumWithin0_10": "10/10",
        "highMeanAbsDelta": 0.037821428571428575,
        "highWithin0_10": "10/10",
    }
