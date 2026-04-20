"""Application settings loaded from environment variables and .env files."""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Blackbox configuration. All BLACKBOX_ prefixed env vars are loaded automatically."""

    model_config = SettingsConfigDict(
        env_prefix="BLACKBOX_",
        env_file=".env",
        env_file_encoding="utf-8",
        populate_by_name=True,
        extra="ignore",
    )

    # API keys (no prefix — loaded as ANTHROPIC_API_KEY / BRAVE_API_KEY)
    anthropic_api_key: str = Field(alias="ANTHROPIC_API_KEY")
    brave_api_key: str = Field(alias="BRAVE_API_KEY")

    # Model selection
    haiku_model: str = "claude-haiku-4-5-20251001"
    sonnet_model: str = "claude-sonnet-4-20250514"

    # Concurrency limits
    brave_max_concurrent: int = 10
    anthropic_max_concurrent: int = 4
    fetch_max_concurrent: int = 10

    # Cache
    cache_dir: Path = Path.home() / ".blackbox" / "cache"
    cache_ttl_days: int = 30

    # Search
    brave_results_per_query: int = 5
    search_timeout_seconds: int = 10
    search_max_retries: int = 3

    # Fetcher
    fetch_max_per_area: int = 3
    fetch_timeout_seconds: int = 10

    # HigherGov API
    highergov_api_key: str = Field(default="", alias="HIGHERGOV_API_KEY")
    highergov_api_base_url: str = Field(
        default="https://www.highergov.com/api-external/opportunity/",
        alias="HIGHERGOV_API_BASE_URL",
    )
    highergov_api_doc_url: str = Field(
        default="https://www.highergov.com/api-external/document/",
        alias="HIGHERGOV_API_DOC_URL",
    )
