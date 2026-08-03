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


def test_model_defaults_to_qwen():
    b = parse_brief("prompt: x")
    assert b["modell"] == "qwen"


def test_model_openai_is_accepted():
    b = parse_brief("prompt: x\nmodell: openai")
    assert b["modell"] == "openai"


def test_invalid_model_falls_back_to_default():
    b = parse_brief("prompt: x\nmodell: midjourney")
    assert b["modell"] == "qwen"


def test_format_sets_width_and_height():
    b = parse_brief("prompt: x\nformat: 1536x1024")
    assert b["width"] == 1536
    assert b["height"] == 1024
    assert b["size"] == "1536x1024"


def test_format_falls_back_when_not_allowed():
    b = parse_brief("prompt: x\nformat: 4096x4096")
    assert b["size"] == "1024x1024"
    assert b["width"] == 1024


def test_size_still_accepted_as_alias_for_format():
    b = parse_brief("prompt: x\nsize: 1024x1536")
    assert b["size"] == "1024x1536"
    assert b["height"] == 1536


def test_format_wins_over_size_when_both_given():
    b = parse_brief("prompt: x\nsize: 1024x1536\nformat: 1536x1024")
    assert b["size"] == "1536x1024"


def test_seed_is_parsed_as_int():
    b = parse_brief("prompt: x\nseed: 4711")
    assert b["seed"] == 4711


def test_seed_absent_is_none():
    assert parse_brief("prompt: x")["seed"] is None


def test_invalid_seed_is_none():
    assert parse_brief("prompt: x\nseed: viele")["seed"] is None


def test_openai_size_maps_unsupported_format():
    b = parse_brief("prompt: x\nformat: 1344x768")
    assert b["size"] == "1344x768"
    assert b["openai_size"] == "1536x1024"


def test_openai_size_passes_supported_format_through():
    b = parse_brief("prompt: x\nformat: 1024x1536")
    assert b["openai_size"] == "1024x1536"


def test_negative_seed_falls_back_to_none():
    assert parse_brief("prompt: x\nseed: -1")["seed"] is None


def test_seed_too_large_falls_back_to_none():
    assert parse_brief("prompt: x\nseed: 18446744073709551616")["seed"] is None


def test_seed_zero_is_accepted():
    b = parse_brief("prompt: x\nseed: 0")
    assert b["seed"] == 0
    assert b["seed"] is not None


def test_seed_at_max_is_accepted():
    b = parse_brief("prompt: x\nseed: 18446744073709551615")
    assert b["seed"] == 18446744073709551615


# --- 360-Modell -----------------------------------------------------------

def test_qwen360_is_accepted_as_model():
    assert parse_brief("prompt: x\nmodell: qwen360")["modell"] == "qwen360"


def test_qwen360_defaults_to_2to1_format():
    """Ohne Formatangabe muss 360 auf 2048x1024 landen -- 1024x1024 waere
    als Panorama unbrauchbar."""
    b = parse_brief("prompt: x\nmodell: qwen360")
    assert b["size"] == "2048x1024"
    assert (b["width"], b["height"]) == (2048, 1024)


def test_qwen360_rejects_non_panorama_format():
    b = parse_brief("prompt: x\nmodell: qwen360\nformat: 1024x1024")
    assert b["size"] == "2048x1024"


def test_qwen360_accepts_other_2to1_formats():
    b = parse_brief("prompt: x\nmodell: qwen360\nformat: 1536x768")
    assert b["size"] == "1536x768"


def test_normal_model_still_rejects_panorama_format():
    """2048x1024 gehoert NUR zu 360; qwen darf nicht heimlich dorthin kippen."""
    b = parse_brief("prompt: x\nmodell: qwen\nformat: 2048x1024")
    assert b["size"] == "1024x1024"


def test_unknown_model_falls_back_to_default_with_default_format():
    b = parse_brief("prompt: x\nmodell: gibtsnicht")
    assert b["modell"] == "qwen"
    assert b["size"] == "1024x1024"
