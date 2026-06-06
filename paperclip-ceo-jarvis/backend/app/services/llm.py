from __future__ import annotations
import httpx
from .personality import fallback_reply
from ..config import get_settings
from ..system_prompt import build_system_prompt


class JarvisLLM:
    def __init__(self):
        self.settings = get_settings()

    async def chat(self, message: str, context: dict | None = None, personality_level: int | None = None) -> str:
        context = context or {}
        if not self.settings.openai_base_url or not self.settings.openai_api_key:
            return fallback_reply(message, context)

        payload = {
            "model": self.settings.openai_model,
            "messages": [
                {"role": "system", "content": build_system_prompt(personality_level)},
                {"role": "user", "content": f"Context: {context}\n\nUser: {message}"},
            ],
            "temperature": 0.35,
        }
        url = self.settings.openai_base_url.rstrip("/") + "/chat/completions"
        headers = {"Authorization": f"Bearer {self.settings.openai_api_key}"}
        try:
            async with httpx.AsyncClient(timeout=45) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]
        except Exception as exc:  # fallback keeps system useful when local model is down
            return fallback_reply(message, {**context, "llm_error": str(exc)})
