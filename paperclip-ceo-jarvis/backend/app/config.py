from functools import lru_cache
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Paperclip CEO Jarvis"
    environment: str = "development"
    database_url: str = "sqlite:///./jarvis.db"
    jarvis_api_key: str = "dev-change-me"
    jarvis_primary_user: str = "Damian"
    jarvis_personality_level: int = 2
    watch_interval_seconds: int = 60
    openai_base_url: str | None = None
    openai_api_key: str | None = None
    openai_model: str = "llama3.1:8b"
    paperclip_base_url: str | None = None
    paperclip_api_key: str | None = None
    paperclip_company_id: str | None = None
    paperclip_agent_id: str | None = None
    hermes_base_url: str | None = None
    hermes_api_key: str | None = None
    hermes_command: str | None = "hermes -z"
    pi_base_url: str | None = None
    pi_api_key: str | None = None
    pi_command: str | None = "pi -p --mode json --tools read,bash,edit,write,grep,find,ls"
    opencode_base_url: str | None = None
    opencode_api_key: str | None = None
    opencode_command: str | None = "opencode run --format json"
    allow_high_risk_actions: bool = False
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> List[str]:
        return [x.strip() for x in self.cors_origins.split(",") if x.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
