from brief_parser import parse_brief

def test_full_brief():
    text = "prompt: Ein Poster mit Text\nsize: 1024x1536\nquality: high\ntransparent: true"
    b = parse_brief(text)
    assert b["prompt"] == "Ein Poster mit Text"
    assert b["size"] == "1024x1536"
    assert b["quality"] == "high"
    assert b["background"] == "transparent"
    assert b["error"] is None

def test_defaults_when_optional_missing():
    b = parse_brief("prompt: Nur ein Prompt")
    assert b["size"] == "1024x1024"
    assert b["quality"] == "medium"
    assert b["background"] == "opaque"
    assert b["error"] is None

def test_missing_prompt_is_error():
    b = parse_brief("size: 1024x1024")
    assert b["error"] is not None

def test_invalid_size_falls_back_to_default():
    b = parse_brief("prompt: x\nsize: 999x999")
    assert b["size"] == "1024x1024"

def test_invalid_quality_falls_back():
    b = parse_brief("prompt: x\nquality: ultra")
    assert b["quality"] == "medium"
