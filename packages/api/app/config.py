from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://localhost:5432/gcp_renovation"
    REDIS_URL: str = ""
    AWS_ACCESS_KEY: str = ""
    AWS_SECRET_KEY: str = ""
    S3_BUCKET: str = ""
    CLERK_SECRET_KEY: str = ""
    # Explicit JWKS URL — fetched at request time when set.
    CLERK_JWKS_URL: str = ""
    # Static JWKS JSON override — when set, no network call is made for auth.
    # Format: {"keys": [{...JWK...}]}
    CLERK_JWKS_OVERRIDE: str = ""
    ANTHROPIC_API_KEY: str = ""
    STRIPE_SECRET_KEY: str = ""
    ZILLOW_API_KEY: str = ""
    RENTCAST_API_KEY: str = ""
    PROPSTREAM_API_KEY: str = ""
    GOOGLE_PLACES_API_KEY: str = ""
    FEMA_API_KEY: str = ""

    # Sage API (formal integration — Sprint 1.9)
    SAGE_API_URL: str = ""
    SAGE_API_KEY: str = ""

    # Dynamics 365
    D365_TENANT_ID: str = ""
    D365_CLIENT_ID: str = ""
    D365_CLIENT_SECRET: str = ""
    D365_RESOURCE_URL: str = ""
    D365_API_URL: str = ""

    # CORS — comma-separated origins, defaults to wildcard for local dev
    CORS_ORIGINS: str = "*"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


settings = Settings()
