import os
import pytest
from app.config import Settings


class TestSettingsDefaults:
    def test_database_url_default(self):
        """Test DATABASE_URL has a default value."""
        settings = Settings()
        assert settings.DATABASE_URL
        assert isinstance(settings.DATABASE_URL, str)

    def test_redis_url_default(self):
        """Test REDIS_URL default is empty string."""
        settings = Settings()
        assert settings.REDIS_URL == ""

    def test_cors_origins_default(self):
        """Test CORS_ORIGINS default is wildcard."""
        settings = Settings()
        assert settings.CORS_ORIGINS == "*"

    def test_aws_keys_default(self):
        """Test AWS keys default to empty."""
        settings = Settings()
        assert settings.AWS_ACCESS_KEY == ""
        assert settings.AWS_SECRET_KEY == ""

    def test_stripe_key_default(self):
        """Test Stripe key defaults to empty."""
        settings = Settings()
        assert settings.STRIPE_SECRET_KEY == ""

    def test_anthropic_key_default(self):
        """Test Anthropic key defaults to empty."""
        settings = Settings()
        assert settings.ANTHROPIC_API_KEY == ""


class TestSettingsTypes:
    def test_database_url_is_string(self):
        """Test DATABASE_URL is string type."""
        settings = Settings()
        assert isinstance(settings.DATABASE_URL, str)

    def test_cors_origins_is_string(self):
        """Test CORS_ORIGINS is string type."""
        settings = Settings()
        assert isinstance(settings.CORS_ORIGINS, str)

    def test_clerk_settings_are_strings(self):
        """Test Clerk settings are strings."""
        settings = Settings()
        assert isinstance(settings.CLERK_SECRET_KEY, str)
        assert isinstance(settings.CLERK_JWKS_URL, str)
        assert isinstance(settings.CLERK_JWKS_OVERRIDE, str)


class TestSettingsEnvironmentOverride:
    def test_database_url_from_env(self):
        """Test DATABASE_URL can be overridden from env."""
        original = os.environ.get("DATABASE_URL")
        try:
            os.environ["DATABASE_URL"] = "sqlite:///test.db"
            settings = Settings()
            assert settings.DATABASE_URL == "sqlite:///test.db"
        finally:
            if original:
                os.environ["DATABASE_URL"] = original
            else:
                os.environ.pop("DATABASE_URL", None)

    def test_cors_origins_from_env(self):
        """Test CORS_ORIGINS can be overridden from env."""
        original = os.environ.get("CORS_ORIGINS")
        try:
            os.environ["CORS_ORIGINS"] = "http://localhost:3000"
            settings = Settings()
            assert settings.CORS_ORIGINS == "http://localhost:3000"
        finally:
            if original:
                os.environ["CORS_ORIGINS"] = original
            else:
                os.environ.pop("CORS_ORIGINS", None)


class TestSettingsExtraFieldHandling:
    def test_extra_fields_ignored(self):
        """Test that extra unknown fields are ignored."""
        settings = Settings()
        assert not hasattr(settings, "unknown_field")


class TestSageAPISettings:
    def test_sage_api_url_default(self):
        """Test Sage API URL defaults to empty."""
        settings = Settings()
        assert settings.SAGE_API_URL == ""

    def test_sage_api_key_default(self):
        """Test Sage API key defaults to empty."""
        settings = Settings()
        assert settings.SAGE_API_KEY == ""


class TestDynamics365Settings:
    def test_d365_tenant_id_default(self):
        """Test D365 tenant ID defaults to empty."""
        settings = Settings()
        assert settings.D365_TENANT_ID == ""

    def test_d365_client_id_default(self):
        """Test D365 client ID defaults to empty."""
        settings = Settings()
        assert settings.D365_CLIENT_ID == ""

    def test_d365_client_secret_default(self):
        """Test D365 client secret defaults to empty."""
        settings = Settings()
        assert settings.D365_CLIENT_SECRET == ""

    def test_d365_resource_url_default(self):
        """Test D365 resource URL defaults to empty."""
        settings = Settings()
        assert settings.D365_RESOURCE_URL == ""

    def test_d365_api_url_default(self):
        """Test D365 API URL defaults to empty."""
        settings = Settings()
        assert settings.D365_API_URL == ""


class TestExternalAPIKeys:
    def test_zillow_api_key_default(self):
        """Test Zillow API key defaults to empty."""
        settings = Settings()
        assert settings.ZILLOW_API_KEY == ""

    def test_rentcast_api_key_default(self):
        """Test RentCast API key defaults to empty."""
        settings = Settings()
        assert settings.RENTCAST_API_KEY == ""

    def test_propstream_api_key_default(self):
        """Test PropStream API key defaults to empty."""
        settings = Settings()
        assert settings.PROPSTREAM_API_KEY == ""

    def test_google_places_api_key_default(self):
        """Test Google Places API key defaults to empty."""
        settings = Settings()
        assert settings.GOOGLE_PLACES_API_KEY == ""

    def test_fema_api_key_default(self):
        """Test FEMA API key defaults to empty."""
        settings = Settings()
        assert settings.FEMA_API_KEY == ""


class TestSettingsSingleton:
    def test_settings_instance_available(self):
        """Test that settings instance is available."""
        from app.config import settings
        assert settings is not None
        assert isinstance(settings, Settings)
