from config import ALLOWED_SIZES, ALLOWED_QUALITIES, DEFAULT_SIZE, DEFAULT_QUALITY

def parse_brief(text):
    fields = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        fields[key.strip().lower()] = val.split("#", 1)[0].strip()

    prompt = fields.get("prompt", "").strip()
    if not prompt:
        return {"error": "Pflichtfeld 'prompt' fehlt oder ist leer.",
                "prompt": None, "size": DEFAULT_SIZE,
                "quality": DEFAULT_QUALITY, "background": "opaque"}

    size = fields.get("size", DEFAULT_SIZE)
    if size not in ALLOWED_SIZES:
        size = DEFAULT_SIZE
    quality = fields.get("quality", DEFAULT_QUALITY)
    if quality not in ALLOWED_QUALITIES:
        quality = DEFAULT_QUALITY
    transparent = fields.get("transparent", "false").lower() in ("true", "1", "ja", "yes")

    return {"error": None, "prompt": prompt, "size": size,
            "quality": quality, "background": "transparent" if transparent else "opaque"}
