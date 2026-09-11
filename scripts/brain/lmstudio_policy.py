import os


FAST_TASKS = {
    "json",
    "extract",
    "classify",
    "memory",
    "vault",
    "consolidate",
    "synthesize_short",
    "tooltip",
    "short",
    "eval",
    "healthcheck",
}

DEEP_TASKS = {
    "deep_reason",
    "long_synthesis",
    "manual_chat",
    "explicit_deep",
    "complex_self_dev",
}


def _env_flag(name: str, default: str = "0") -> bool:
    return str(os.getenv(name, default)).strip().lower() in {"1", "true", "yes", "on"}


def normalize_model_id(model_id):
    model_id = (model_id or "").strip()
    if ":" in model_id:
        base, suffix = model_id.rsplit(":", 1)
        if suffix.isdigit():
            return base
    return model_id


def get_lmstudio_config():
    return {
        "base_url": os.getenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234").rstrip("/"),
        "fast_model": os.getenv("LMSTUDIO_FAST_MODEL", "qwen2.5-7b-instruct"),
        "deep_model": os.getenv("LMSTUDIO_DEEP_MODEL", "qwen3.6-35b-a3b"),
        "embed_model": os.getenv("LMSTUDIO_EMBED_MODEL", "text-embedding-nomic-embed-text-v1.5"),
        "ttl": int(os.getenv("LMSTUDIO_TTL", "300")),
        "allow_deep_auto": _env_flag("LMSTUDIO_ALLOW_DEEP_AUTO", "0"),
        "use_native_api": _env_flag("LMSTUDIO_USE_NATIVE_API", "0"),
        "jit_enabled": _env_flag("LMSTUDIO_JIT_ENABLED", "0"),
    }


def is_deep_model(model_id):
    cfg = get_lmstudio_config()
    return normalize_model_id(model_id) == normalize_model_id(cfg["deep_model"])


def is_embedding_model(model_id):
    cfg = get_lmstudio_config()
    return normalize_model_id(model_id) == normalize_model_id(cfg["embed_model"])


def task_uses_fast(task_type):
    return (task_type or "").strip().lower() in FAST_TASKS


def task_uses_deep(task_type):
    return (task_type or "").strip().lower() in DEEP_TASKS


def select_lmstudio_model(task_type=None, requested_model=None, automatic=True, available_models=None):
    cfg = get_lmstudio_config()
    fast_model = cfg["fast_model"]
    deep_model = cfg["deep_model"]
    if requested_model:
        selected = requested_model
    elif task_uses_deep(task_type):
        selected = deep_model
    else:
        selected = fast_model if automatic or task_uses_fast(task_type) else deep_model

    normalized_available = {
        normalize_model_id(model_id)
        for model_id in (available_models or [])
    }

    if automatic and is_deep_model(selected) and not cfg["allow_deep_auto"]:
        if normalize_model_id(fast_model) in normalized_available:
            return fast_model
        raise RuntimeError("local_fast_model_unavailable")

    if normalized_available:
        normalized_selected = normalize_model_id(selected)
        if normalized_selected in normalized_available:
            return selected
        if automatic and normalize_model_id(fast_model) in normalized_available:
            return fast_model
        if automatic:
            raise RuntimeError("local_fast_model_unavailable")
        raise RuntimeError("requested_local_model_unavailable")

    return selected


def add_lmstudio_ttl(payload):
    cfg = get_lmstudio_config()
    ttl = cfg["ttl"]
    if ttl > 0:
        payload["ttl"] = ttl
    return payload
