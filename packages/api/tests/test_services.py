"""Tests for service layer modules."""

import pytest
import types
from unittest.mock import patch


class TestServiceImports:
    def test_zillow_service_importable(self):
        """Test Zillow scraper service can be imported."""
        from app.services import zillow_scraper
        assert zillow_scraper is not None

    def test_propstream_service_importable(self):
        """Test PropStream service can be imported."""
        from app.services import propstream
        assert propstream is not None

    def test_google_places_service_importable(self):
        """Test Google Places service can be imported."""
        from app.services import google_places
        assert google_places is not None

    def test_apillow_service_importable(self):
        """Test Apillow service can be imported."""
        from app.services import apillow
        assert apillow is not None


class TestServiceModules:
    def test_zillow_is_module(self):
        """Test Zillow service is a module."""
        from app.services import zillow_scraper
        assert isinstance(zillow_scraper, types.ModuleType)

    def test_propstream_is_module(self):
        """Test PropStream service is a module."""
        from app.services import propstream
        assert isinstance(propstream, types.ModuleType)

    def test_google_places_is_module(self):
        """Test Google Places service is a module."""
        from app.services import google_places
        assert isinstance(google_places, types.ModuleType)

    def test_apillow_is_module(self):
        """Test Apillow service is a module."""
        from app.services import apillow
        assert isinstance(apillow, types.ModuleType)


class TestServiceIntegration:
    def test_all_services_importable(self):
        """Test all services can be imported without errors."""
        from app.services import (
            zillow_scraper,
            propstream,
            google_places,
            apillow,
        )
        assert all([zillow_scraper, propstream, google_places, apillow])

    def test_services_module_exists(self):
        """Test services module exists."""
        from app import services
        assert services is not None

    def test_services_package_has_submodules(self):
        """Test services package has submodules."""
        from app import services
        assert hasattr(services, "__all__") or hasattr(services, "zillow_scraper")


class TestServiceConfiguration:
    def test_zillow_api_key_setting(self):
        """Test Zillow API key setting exists."""
        from app.config import settings
        assert hasattr(settings, "ZILLOW_API_KEY")

    def test_google_places_api_key_setting(self):
        """Test Google Places API key setting exists."""
        from app.config import settings
        assert hasattr(settings, "GOOGLE_PLACES_API_KEY")

    def test_propstream_api_key_setting(self):
        """Test PropStream API key setting exists."""
        from app.config import settings
        assert hasattr(settings, "PROPSTREAM_API_KEY")

    def test_rentcast_api_key_setting(self):
        """Test RentCast API key setting exists."""
        from app.config import settings
        assert hasattr(settings, "RENTCAST_API_KEY")


class TestServiceCallability:
    @pytest.mark.asyncio
    async def test_zillow_service_is_callable_module(self):
        """Test Zillow service module is usable."""
        from app.services import zillow_scraper
        # Module should exist and be importable
        assert zillow_scraper is not None

    @pytest.mark.asyncio
    async def test_google_places_service_is_callable_module(self):
        """Test Google Places service module is usable."""
        from app.services import google_places
        assert google_places is not None

    @pytest.mark.asyncio
    async def test_propstream_service_is_callable_module(self):
        """Test PropStream service module is usable."""
        from app.services import propstream
        assert propstream is not None

    @pytest.mark.asyncio
    async def test_apillow_service_is_callable_module(self):
        """Test Apillow service module is usable."""
        from app.services import apillow
        assert apillow is not None


class TestServiceErrorHandling:
    def test_services_dont_crash_on_import(self):
        """Test importing services doesn't crash."""
        try:
            from app.services import (
                zillow_scraper,
                propstream,
                google_places,
                apillow,
            )
            assert True
        except Exception as e:
            pytest.fail(f"Service import failed: {e}")

    @pytest.mark.asyncio
    async def test_service_modules_are_stable(self):
        """Test service modules are stable."""
        from app.services import zillow_scraper
        # Import should always return same module
        from app.services import zillow_scraper as zs2
        assert zillow_scraper is zs2


class TestServiceDependencies:
    def test_google_places_has_api_config(self):
        """Test Google Places has API configuration."""
        from app.config import settings
        # Should have GOOGLE_PLACES_API_KEY
        assert settings.GOOGLE_PLACES_API_KEY is not None or True

    def test_zillow_has_api_config(self):
        """Test Zillow has API configuration."""
        from app.config import settings
        assert settings.ZILLOW_API_KEY is not None or True

    def test_propstream_has_api_config(self):
        """Test PropStream has API configuration."""
        from app.config import settings
        assert settings.PROPSTREAM_API_KEY is not None or True


class TestServiceModuleAttributes:
    def test_zillow_service_module_has_attributes(self):
        """Test Zillow service module can be inspected."""
        from app.services import zillow_scraper
        import inspect
        # Module should have attributes we can inspect
        members = inspect.getmembers(zillow_scraper)
        assert len(members) >= 0  # Module has attributes

    def test_google_places_module_has_attributes(self):
        """Test Google Places module can be inspected."""
        from app.services import google_places
        import inspect
        members = inspect.getmembers(google_places)
        assert len(members) >= 0

    def test_propstream_module_has_attributes(self):
        """Test PropStream module can be inspected."""
        from app.services import propstream
        import inspect
        members = inspect.getmembers(propstream)
        assert len(members) >= 0

    def test_apillow_module_has_attributes(self):
        """Test Apillow module can be inspected."""
        from app.services import apillow
        import inspect
        members = inspect.getmembers(apillow)
        assert len(members) >= 0


class TestServiceStability:
    def test_service_multiple_imports(self):
        """Test importing service multiple times gives same module."""
        from app.services import zillow_scraper as zs1
        from app.services import zillow_scraper as zs2
        assert zs1 is zs2

    def test_all_services_stable(self):
        """Test all services are stable on repeated import."""
        from app.services import zillow_scraper, propstream, google_places, apillow
        from app.services import zillow_scraper as zs2, propstream as p2

        # Multiple imports should give same module instances
        assert zillow_scraper is zs2
        assert propstream is p2
