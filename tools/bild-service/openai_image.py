import json, base64, urllib.request, urllib.error
from config import SECRETS_ENV, read_secret

def _load_openai_key():
    return read_secret(SECRETS_ENV, "OPENAI_API_KEY")

def build_request_body(brief):
    return {
        "model": "gpt-image-1",
        "prompt": brief["prompt"],
        "size": brief["size"],
        "quality": brief["quality"],
        "background": brief["background"],
        "output_format": "png",
        "n": 1,
    }

def generate_png(brief, timeout=180):
    body = json.dumps(build_request_body(brief)).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations", data=body,
        headers={"Authorization": f"Bearer {_load_openai_key()}",
                 "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"OpenAI HTTP {e.code}: {detail}")
    b64 = data["data"][0]["b64_json"]
    return base64.b64decode(b64)
