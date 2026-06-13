import json

def extract_lmstudio_content(choice, expect_json=False):
    """
    Extracts usable content from LM Studio responses.

    Workaround for Qwen reasoning models:
    sometimes structured JSON is returned in message.reasoning_content
    while message.content is empty.
    """
    msg = choice.get("message", {}) or {}
    content = (msg.get("content") or "").strip()
    reasoning = (msg.get("reasoning_content") or "").strip()
    finish = choice.get("finish_reason")

    if finish == "length":
        raise RuntimeError("lmstudio_output_truncated")

    if content:
        return content

    if expect_json and finish == "stop" and reasoning:
        if reasoning.startswith("{") or reasoning.startswith("["):
            try:
                json.loads(reasoning)
                return reasoning
            except Exception as e:
                raise RuntimeError(f"reasoning_content_not_valid_json: {e}")

    if reasoning:
        raise RuntimeError("empty_content_with_reasoning_output")

    raise RuntimeError("empty_lmstudio_output")


def parse_lmstudio_json(choice):
    text = extract_lmstudio_content(choice, expect_json=True)
    return json.loads(text)
