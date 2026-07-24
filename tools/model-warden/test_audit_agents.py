import os
from config import load_resident_set
from audit_agents import resident_model_keys, violations

HERE = os.path.dirname(__file__)
ALLOWED = resident_model_keys(load_resident_set(os.path.join(HERE, "resident-set.json")))

def test_allowed_contains_set_and_cloud():
    assert "gemma-4-31b-it-mlx" in ALLOWED
    assert "qwen/qwen3-coder-next" in ALLOWED

def test_clean_config_no_violations():
    cfg = {"model": "gemma-4-31b-it-mlx", "fallbackModel": "google/gemma-4-12b",
           "defaultModel": "gemma-4-31b-it-mlx"}
    assert violations(cfg, ALLOWED) == []

def test_cloud_model_ignored():
    cfg = {"model": "claude-sonnet-4-6", "fallbackModel": ""}
    assert violations(cfg, ALLOWED) == []

def test_mistral_flagged():
    cfg = {"model": "mistral-small-3.2-24b-instruct-2506-mlx",
           "fallbackModel": "google/gemma-4-12b", "defaultModel": "gemma-4-31b-it-mlx"}
    v = violations(cfg, ALLOWED)
    assert any("model" == f.split(":")[0] for f in v)

def test_cheap_profile_checked():
    cfg = {"model": "gemma-4-31b-it-mlx", "fallbackModel": "google/gemma-4-12b",
           "modelProfiles": {"cheap": {"adapterConfig": {"model": "mistral-small-3.2-24b-instruct-2506-mlx"}}}}
    assert violations(cfg, ALLOWED)
