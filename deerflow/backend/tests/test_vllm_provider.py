"""Tests for the VllmChatModel provider and its helper functions.

Covers:
- _normalize_vllm_chat_template_kwargs payload normalization
- _reasoning_to_text extraction from various input types
- VllmChatModel class identity and construction
"""

from __future__ import annotations

import copy

from langchain_openai import ChatOpenAI

from src.models.vllm_provider import (
    VllmChatModel,
    _normalize_vllm_chat_template_kwargs,
    _reasoning_to_text,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_payload(**overrides) -> dict:
    """Build a minimal request payload dict with optional overrides."""
    base: dict = {"model": "test-model", "messages": []}
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# _normalize_vllm_chat_template_kwargs
# ---------------------------------------------------------------------------


def test_normalize_noop_without_extra_body():
    """Payload without extra_body is unchanged."""
    payload = _make_payload()
    original = copy.deepcopy(payload)
    _normalize_vllm_chat_template_kwargs(payload)
    assert payload == original


def test_normalize_noop_without_chat_template_kwargs():
    """extra_body without chat_template_kwargs is unchanged."""
    payload = _make_payload(extra_body={"some_key": "some_value"})
    original = copy.deepcopy(payload)
    _normalize_vllm_chat_template_kwargs(payload)
    assert payload == original


def test_normalize_maps_thinking_to_enable_thinking():
    """thinking: true becomes enable_thinking: true, thinking key removed."""
    payload = _make_payload(
        extra_body={
            "chat_template_kwargs": {"thinking": True},
        },
    )
    _normalize_vllm_chat_template_kwargs(payload)
    ctk = payload["extra_body"]["chat_template_kwargs"]
    assert ctk.get("enable_thinking") is True
    assert "thinking" not in ctk


def test_normalize_preserves_existing_enable_thinking():
    """If both present, enable_thinking takes precedence."""
    payload = _make_payload(
        extra_body={
            "chat_template_kwargs": {"thinking": True, "enable_thinking": False},
        },
    )
    _normalize_vllm_chat_template_kwargs(payload)
    ctk = payload["extra_body"]["chat_template_kwargs"]
    assert ctk["enable_thinking"] is False
    assert "thinking" not in ctk


def test_normalize_noop_without_thinking_key():
    """chat_template_kwargs without thinking key is unchanged."""
    payload = _make_payload(
        extra_body={
            "chat_template_kwargs": {"enable_thinking": True, "other": 42},
        },
    )
    original = copy.deepcopy(payload)
    _normalize_vllm_chat_template_kwargs(payload)
    assert payload == original


# ---------------------------------------------------------------------------
# _reasoning_to_text
# ---------------------------------------------------------------------------


def test_reasoning_to_text_from_string():
    """String input returns the same string."""
    assert _reasoning_to_text("hello reasoning") == "hello reasoning"


def test_reasoning_to_text_from_dict():
    """Dict with 'text' key returns the value."""
    assert _reasoning_to_text({"text": "thinking hard"}) == "thinking hard"


def test_reasoning_to_text_from_list():
    """List of items joins them."""
    result = _reasoning_to_text(["step one", "step two"])
    assert result == "step onestep two"


def test_reasoning_to_text_none():
    """None falls through to json.dumps which returns 'null'."""
    result = _reasoning_to_text(None)
    assert result == "null"


# ---------------------------------------------------------------------------
# VllmChatModel class
# ---------------------------------------------------------------------------


def test_vllm_chat_model_is_subclass_of_chat_openai():
    """VllmChatModel inherits from ChatOpenAI."""
    assert issubclass(VllmChatModel, ChatOpenAI)


def test_vllm_chat_model_constructor(monkeypatch):
    """VllmChatModel can be instantiated with model/base_url/api_key."""
    # Ensure OPENAI_API_KEY env var does not interfere
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key")
    model = VllmChatModel(
        model="test-vllm-model",
        base_url="http://localhost:8000/v1",
        api_key="fake-key",
    )
    assert isinstance(model, VllmChatModel)
    assert isinstance(model, ChatOpenAI)
    assert model._llm_type == "vllm-openai-compatible"
