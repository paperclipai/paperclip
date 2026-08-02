#!/usr/bin/env python3
"""
Model-watch/catalog guardrails for adapter catalog reconciliation.

The direct Codex OAuth probe can prove a model slug exists even when the served
adapter catalog omits it. Usage-limit text is therefore quota/availability
evidence, not evidence that the model is nonexistent.
"""

import benchlib

MODEL_EXISTS_QUOTA_GATED_CATALOG_MISSING = "model_exists_quota_gated_catalog_missing"
MODEL_IN_SERVED_ADAPTER_CATALOG = "model_in_served_adapter_catalog"
MODEL_ABSENT_CATALOG_UNVERIFIED = "model_absent_from_served_adapter_catalog_unverified"


def normalize_model_ids(models):
    normalized = set()
    for model in models or []:
        if isinstance(model, str):
            model_id = model
        elif isinstance(model, dict):
            model_id = model.get("id") or model.get("model") or model.get("model_id")
        else:
            model_id = None
        model_id = str(model_id or "").strip()
        if model_id:
            normalized.add(model_id)
    return normalized


def classify_catalog_reconciliation(adapter_type, model_id, served_catalog, direct_probe_text="", active_pin=True):
    served_model_ids = normalize_model_ids(served_catalog)
    if model_id in served_model_ids:
        return MODEL_IN_SERVED_ADAPTER_CATALOG
    if (
        active_pin
        and adapter_type == "codex_local"
        and benchlib.is_provider_quota_text(direct_probe_text)
    ):
        return MODEL_EXISTS_QUOTA_GATED_CATALOG_MISSING
    return MODEL_ABSENT_CATALOG_UNVERIFIED
