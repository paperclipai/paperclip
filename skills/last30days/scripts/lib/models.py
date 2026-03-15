"""Model auto-selection for last30days skill."""

import re
from typing import Dict, List, Optional, Tuple

from . import cache, http, env

# OpenAI API
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
OPENAI_FALLBACK_MODELS = ["gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"]
CODEX_FALLBACK_MODELS = ["gpt-5.1-codex-mini", "gpt-5.2"]

# xAI API - Agent Tools API requires grok-4 family
XAI_MODELS_URL = "https://api.x.ai/v1/models"
XAI_ALIASES = {
    "latest": "grok-4-1-fast",  # Required for x_search tool
    "stable": "grok-4-1-fast",
}


def parse_version(model_id: str) -> Optional[Tuple[int, ...]]:
    """Parse semantic version from model ID.

    Examples:
        gpt-5 -> (5,)
        gpt-5.2 -> (5, 2)
        gpt-5.2.1 -> (5, 2, 1)
    """
    match = re.search(r'(\d+(?:\.\d+)*)', model_id)
    if match:
        return tuple(int(x) for x in match.group(1).split('.'))
    return None


def is_mainline_openai_model(model_id: str) -> bool:
    """Check if model is a mainline GPT model (not mini/nano/chat/codex/pro)."""
    model_lower = model_id.lower()

    # Must be gpt-4o, gpt-4.1+, or gpt-5+ series (mainline, not mini/nano/etc)
    if not re.match(r'^gpt-(?:4o|4\.1|5)(\.\d+)*$', model_lower):
        return False

    # Exclude variants
    excludes = ['mini', 'nano', 'chat', 'codex', 'pro', 'preview', 'turbo']
    for exc in excludes:
        if exc in model_lower:
            return False

    return True


def select_openai_model(
    api_key: str,
    policy: str = "auto",
    pin: Optional[str] = None,
    mock_models: Optional[List[Dict]] = None,
) -> str:
    """Select the best OpenAI model based on policy.

    Args:
        api_key: OpenAI API key
        policy: 'auto' or 'pinned'
        pin: Model to use if policy is 'pinned'
        mock_models: Mock model list for testing

    Returns:
        Selected model ID
    """
    if policy == "pinned" and pin:
        return pin

    # Check cache first
    cached = cache.get_cached_model("openai")
    if cached:
        return cached

    # Fetch model list
    if mock_models is not None:
        models = mock_models
    else:
        try:
            headers = {"Authorization": f"Bearer {api_key}"}
            response = http.get(OPENAI_MODELS_URL, headers=headers)
            models = response.get("data", [])
        except http.HTTPError:
            # Fall back to known models
            return OPENAI_FALLBACK_MODELS[0]

    # Filter to mainline models
    candidates = [m for m in models if is_mainline_openai_model(m.get("id", ""))]

    if not candidates:
        # No gpt-5 models found, use fallback
        return OPENAI_FALLBACK_MODELS[0]

    # Sort by version (descending), then by created timestamp
    def sort_key(m):
        version = parse_version(m.get("id", "")) or (0,)
        created = m.get("created", 0)
        return (version, created)

    candidates.sort(key=sort_key, reverse=True)
    selected = candidates[0]["id"]

    # Cache the selection
    cache.set_cached_model("openai", selected)

    return selected


def select_xai_model(
    api_key: str,
    policy: str = "latest",
    pin: Optional[str] = None,
    mock_models: Optional[List[Dict]] = None,
) -> str:
    """Select the best xAI model based on policy.

    Args:
        api_key: xAI API key
        policy: 'latest', 'stable', or 'pinned'
        pin: Model to use if policy is 'pinned'
        mock_models: Mock model list for testing

    Returns:
        Selected model ID
    """
    if policy == "pinned" and pin:
        return pin

    # Use alias system
    if policy in XAI_ALIASES:
        alias = XAI_ALIASES[policy]

        # Check cache first
        cached = cache.get_cached_model("xai")
        if cached:
            return cached

        # Cache the alias
        cache.set_cached_model("xai", alias)
        return alias

    # Default to latest
    return XAI_ALIASES["latest"]


def get_models(
    config: Dict,
    mock_openai_models: Optional[List[Dict]] = None,
    mock_xai_models: Optional[List[Dict]] = None,
) -> Dict[str, Optional[str]]:
    """Get selected models for both providers.

    Returns:
        Dict with 'openai' and 'xai' keys
    """
    result = {"openai": None, "xai": None}

    if config.get("OPENAI_API_KEY"):
        if config.get("OPENAI_AUTH_SOURCE") == env.AUTH_SOURCE_CODEX:
            # Codex auth doesn't use the OpenAI models list endpoint
            policy = config.get("OPENAI_MODEL_POLICY", "auto")
            pin = config.get("OPENAI_MODEL_PIN")
            if policy == "pinned" and pin:
                result["openai"] = pin
            else:
                result["openai"] = CODEX_FALLBACK_MODELS[0]
        else:
            result["openai"] = select_openai_model(
                config["OPENAI_API_KEY"],
                config.get("OPENAI_MODEL_POLICY", "auto"),
                config.get("OPENAI_MODEL_PIN"),
                mock_openai_models,
            )

    if config.get("XAI_API_KEY"):
        result["xai"] = select_xai_model(
            config["XAI_API_KEY"],
            config.get("XAI_MODEL_POLICY", "latest"),
            config.get("XAI_MODEL_PIN"),
            mock_xai_models,
        )

    return result
