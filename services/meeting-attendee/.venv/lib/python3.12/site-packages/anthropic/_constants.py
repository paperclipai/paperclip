# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import httpx

RAW_RESPONSE_HEADER = "X-Stainless-Raw-Response"
OVERRIDE_CAST_TO_HEADER = "____stainless_override_cast_to"

# default timeout is 10 minutes
DEFAULT_TIMEOUT = httpx.Timeout(timeout=10 * 60, connect=5.0)
DEFAULT_MAX_RETRIES = 2
DEFAULT_CONNECTION_LIMITS = httpx.Limits(max_connections=1000, max_keepalive_connections=100)

INITIAL_RETRY_DELAY = 0.5
MAX_RETRY_DELAY = 8.0

HUMAN_PROMPT = "\n\nHuman:"

AI_PROMPT = "\n\nAssistant:"

MODEL_NONSTREAMING_TOKENS = {
    "claude-opus-4-20250514": 8_192,
    "claude-opus-4-0": 8_192,
    "claude-4-opus-20250514": 8_192,
    "anthropic.claude-opus-4-20250514-v1:0": 8_192,
    "claude-opus-4@20250514": 8_192,
    "claude-opus-4-1-20250805": 8192,
    "anthropic.claude-opus-4-1-20250805-v1:0": 8192,
    "claude-opus-4-1@20250805": 8192,
}
