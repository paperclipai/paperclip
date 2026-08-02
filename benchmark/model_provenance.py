#!/usr/bin/env python3
"""Model provenance corrections for benchmark reporting.

The benchmark ledger keeps the originally requested model labels intact, but
aggregate views need to use the model that was actually served after provider
retirements/redirects.
"""

from __future__ import annotations

import copy
import re
from datetime import datetime, timezone


RETIREMENT_CUTOFF = datetime(2026, 5, 15, tzinfo=timezone.utc)
XAI_RETIREMENT_SOURCE = "docs.x.ai May-15 retirement; Hermes xai-oauth catalog exclusion"

_ALIAS_VARIANT_PREFIXES = (
    "grok-4-fast",
    "grok-4-1-fast",
    "grok-4.1-fast",
)

_EXACT_ALIASES = {
    "grok-4-0709",
    "grok-code-fast-1",
}

RETIRED_ALIAS_TARGETS = {
    "grok-4-fast": {
        "served_model": "grok-4.3",
        "replacement": "grok-4.3",
    },
    "grok-4-1-fast": {
        "served_model": "grok-4.3",
        "replacement": "grok-4.3",
    },
    "grok-4.1-fast": {
        "served_model": "grok-4.3",
        "replacement": "grok-4.3",
    },
    "grok-4-0709": {
        "served_model": "grok-4.3",
        "replacement": "grok-4.3",
    },
    "grok-code-fast-1": {
        "served_model": "grok-build-0.1",
        "replacement": "grok-build-0.1",
    },
}

_ROW_MODEL_KEYS = (
    "model",
    "model_id",
    "requested_model",
    "requested_model_id",
    "requestedModelArg",
    "requestedModelId",
    "model_reported",
    "served_model",
    "servedModel",
    "trueModelId",
)


def _clean(value):
    return str(value or "").strip().lower()


def retired_alias_for_value(value):
    """Return the canonical retired alias family for a model string, if any."""
    cleaned = _clean(value)
    if not cleaned:
        return None
    if cleaned in _EXACT_ALIASES:
        return cleaned
    for prefix in _ALIAS_VARIANT_PREFIXES:
        if cleaned == prefix or cleaned.startswith(prefix + "-"):
            return prefix
    return None


def retired_alias_info(value):
    alias = retired_alias_for_value(value)
    if not alias:
        return None
    cleaned = _clean(value)
    info = dict(RETIRED_ALIAS_TARGETS[alias])
    if alias in _ALIAS_VARIANT_PREFIXES and "non-reasoning" in cleaned:
        info["reasoning_effort"] = "none"
    info["alias"] = alias
    info["retired_at"] = RETIREMENT_CUTOFF.date().isoformat()
    info["source"] = XAI_RETIREMENT_SOURCE
    return info


def _parse_ts(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def row_timestamp(row):
    for key in ("ts", "pass_finished_at", "run_finished_at", "passFinishedAt", "runFinishedAt"):
        parsed = _parse_ts(row.get(key))
        if parsed is not None:
            return parsed
    return None


def row_retired_alias_info(row):
    """Return retired alias metadata for post-cutoff benchmark rows."""
    ts = row_timestamp(row)
    if ts is None or ts < RETIREMENT_CUTOFF:
        return None
    for key in _ROW_MODEL_KEYS:
        info = retired_alias_info(row.get(key))
        if info:
            info["matched_field"] = key
            return info
    return None


def annotate_row(row):
    """Add a non-destructive served-model correction annotation when applicable."""
    info = row_retired_alias_info(row)
    if not info:
        return False
    before = copy.deepcopy(row)
    original_model = row.get("model") or row.get("model_id")
    if original_model and original_model != info["served_model"]:
        row.setdefault("model_original", original_model)
    row["served_model_corrected"] = info["served_model"]
    row["model_effective"] = info["served_model"]
    row["provenance_correction"] = (
        "TSBC-1571: xAI retired alias requests after 2026-05-15; "
        f"{info['alias']} should aggregate as {info['served_model']}"
    )
    row["provenance_correction_source"] = info["source"]
    if info.get("reasoning_effort"):
        row.setdefault("served_model_corrected_effort", info["reasoning_effort"])
    return row != before


def row_for_reporting(row):
    """Return a copy whose model key is folded to the corrected served model."""
    folded = dict(row)
    info = row_retired_alias_info(row)
    effective = folded.get("model_effective") or folded.get("served_model_corrected")
    if info and not effective:
        effective = info["served_model"]
    if effective and folded.get("model") != effective:
        folded.setdefault("model_original", folded.get("model"))
        folded["model"] = effective
    return folded


def effective_model_id_for_record(record, key="model_id"):
    """Return the model id a per-run record should aggregate under."""
    info = row_retired_alias_info(record)
    if info:
        return info["served_model"]
    return record.get(key)


def retired_alias_error(model_arg, served_model=None):
    info = retired_alias_info(model_arg)
    if not info:
        return None
    served = served_model or info["served_model"]
    effort = ""
    if info.get("reasoning_effort"):
        effort = f" with reasoning effort `{info['reasoning_effort']}`"
    return (
        f"retired_model_alias: requested {model_arg}, retired on 2026-05-15; "
        f"use {info['replacement']}{effort}. Observed/effective served model: {served}."
    )


def contains_retired_alias(text):
    if retired_alias_for_value(text):
        return True
    return any(retired_alias_for_value(part) for part in re.split(r"[\s,;]+", str(text or "")))
