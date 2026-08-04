from config import (ALLOWED_QUALITIES, DEFAULT_QUALITY,
                    ALLOWED_FORMATS, DEFAULT_FORMAT, MODEL_FORMATS,
                    ALLOWED_MODELS, DEFAULT_MODEL, OPENAI_FORMAT_MAP, MAX_SEED,
                    EDIT_MODELS)


def _fields(text):
    out = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        out[key.strip().lower()] = val.split("#", 1)[0].strip()
    return out


def _seed(raw):
    try:
        n = int(raw)
        if 0 <= n <= MAX_SEED:
            return n
        return None
    except (TypeError, ValueError):
        return None


def _result(error, prompt, fmt, quality, background, modell, seed,
            format_ignored=False):
    width, height = (int(p) for p in fmt.split("x"))
    return {
        "error": error,
        "prompt": prompt,
        "modell": modell,
        "size": fmt,
        "width": width,
        "height": height,
        "openai_size": OPENAI_FORMAT_MAP.get(fmt, fmt),
        "quality": quality,
        "background": background,
        "seed": seed,
        "format_ignored": format_ignored,
    }


def parse_brief(text):
    fields = _fields(text)

    prompt = fields.get("prompt", "").strip()
    if not prompt:
        return _result("Pflichtfeld 'prompt' fehlt oder ist leer.", None,
                       DEFAULT_FORMAT, DEFAULT_QUALITY, "opaque",
                       DEFAULT_MODEL, None)

    # Das Modell wird VOR dem Format ausgewertet: 360 hat einen eigenen
    # Formatvorrat, und ein 1024x1024-Panorama waere unbrauchbar.
    modell = fields.get("modell", DEFAULT_MODEL).lower()
    if modell not in ALLOWED_MODELS:
        modell = DEFAULT_MODEL

    # Bei Bild->Bild bestimmt das Quellbild die Ausgabegroesse. Ein trotzdem
    # angegebenes 'format' wird verworfen -- aber sichtbar, nicht still.
    format_ignored = False
    if modell in EDIT_MODELS:
        format_ignored = bool(fields.get("format") or fields.get("size"))
        fmt = DEFAULT_FORMAT
    else:
        spec = MODEL_FORMATS.get(modell)
        allowed = spec["allowed"] if spec else ALLOWED_FORMATS
        fallback = spec["default"] if spec else DEFAULT_FORMAT
        # 'format' ist der Name laut Spec, 'size' bleibt als Alias erlaubt,
        # damit bestehende Auftraege nicht brechen.
        fmt = fields.get("format") or fields.get("size") or fallback
        if fmt not in allowed:
            fmt = fallback

    quality = fields.get("quality", DEFAULT_QUALITY)
    if quality not in ALLOWED_QUALITIES:
        quality = DEFAULT_QUALITY

    transparent = fields.get("transparent", "false").lower() in ("true", "1", "ja", "yes")

    return _result(None, prompt, fmt, quality,
                   "transparent" if transparent else "opaque",
                   modell, _seed(fields.get("seed")), format_ignored)
