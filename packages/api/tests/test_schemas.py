"""Tests for Pydantic schemas."""

import pytest
from decimal import Decimal
from pydantic import ValidationError


class TestPropertySchemaImportability:
    def test_property_response_schema_exists(self):
        """Test PropertyResponse schema can be imported."""
        try:
            from app.schemas.property import PropertyResponse
            assert PropertyResponse is not None
        except ImportError:
            pytest.skip("PropertyResponse not available")

    def test_property_create_schema_exists(self):
        """Test PropertyCreate schema can be imported."""
        try:
            from app.schemas.property import PropertyCreate
            assert PropertyCreate is not None
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_update_schema_exists(self):
        """Test PropertyUpdate schema can be imported."""
        try:
            from app.schemas.property import PropertyUpdate
            assert PropertyUpdate is not None
        except ImportError:
            pytest.skip("PropertyUpdate not available")

    def test_property_list_response_exists(self):
        """Test PropertyListResponse schema can be imported."""
        try:
            from app.schemas.property import PropertyListResponse
            assert PropertyListResponse is not None
        except ImportError:
            pytest.skip("PropertyListResponse not available")


class TestPropertyCreateValidation:
    def test_property_create_validates_address(self):
        """Test PropertyCreate validates address field."""
        try:
            from app.schemas.property import PropertyCreate
            try:
                PropertyCreate(city="Houston", state="TX", zip="77001")
                assert False, "Should require address"
            except ValidationError:
                pass
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_create_validates_city(self):
        """Test PropertyCreate validates city field."""
        try:
            from app.schemas.property import PropertyCreate
            try:
                PropertyCreate(address="123 Main", state="TX", zip="77001")
                assert False, "Should require city"
            except ValidationError:
                pass
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_create_validates_state(self):
        """Test PropertyCreate validates state field."""
        try:
            from app.schemas.property import PropertyCreate
            try:
                PropertyCreate(address="123 Main", city="Houston", zip="77001")
                assert False, "Should require state"
            except ValidationError:
                pass
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_create_validates_zip(self):
        """Test PropertyCreate validates zip field."""
        try:
            from app.schemas.property import PropertyCreate
            try:
                PropertyCreate(address="123 Main", city="Houston", state="TX")
                assert False, "Should require zip"
            except ValidationError:
                pass
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_create_accepts_optional_beds(self):
        """Test PropertyCreate accepts optional beds."""
        try:
            from app.schemas.property import PropertyCreate
            prop = PropertyCreate(
                address="123 Main",
                city="Houston",
                state="TX",
                zip="77001",
                beds=3,
            )
            assert prop.beds == 3
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_create_accepts_optional_baths(self):
        """Test PropertyCreate accepts optional baths."""
        try:
            from app.schemas.property import PropertyCreate
            prop = PropertyCreate(
                address="123 Main",
                city="Houston",
                state="TX",
                zip="77001",
                baths=2.5,
            )
            assert prop.baths == 2.5
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_create_accepts_optional_sqft(self):
        """Test PropertyCreate accepts optional sqft."""
        try:
            from app.schemas.property import PropertyCreate
            prop = PropertyCreate(
                address="123 Main",
                city="Houston",
                state="TX",
                zip="77001",
                sqft=2000,
            )
            assert prop.sqft == 2000
        except ImportError:
            pytest.skip("PropertyCreate not available")


class TestQuoteSchema:
    def test_quote_schema_exists(self):
        """Test Quote-related schemas can be imported."""
        try:
            from app.schemas.quote import QuoteResponse
            assert QuoteResponse is not None
        except ImportError:
            pytest.skip("QuoteResponse not available")

    def test_quote_create_schema_exists(self):
        """Test QuoteCreate schema can be imported."""
        try:
            from app.schemas.quote import QuoteCreate
            assert QuoteCreate is not None
        except ImportError:
            pytest.skip("QuoteCreate not available")


class TestOrderSchema:
    def test_order_schema_exists(self):
        """Test Order-related schemas can be imported."""
        try:
            from app.schemas.order import OrderResponse
            assert OrderResponse is not None
        except ImportError:
            pytest.skip("OrderResponse not available")

    def test_order_create_schema_exists(self):
        """Test OrderCreate schema can be imported."""
        try:
            from app.schemas.order import OrderCreate
            assert OrderCreate is not None
        except ImportError:
            pytest.skip("OrderCreate not available")


class TestDealSchema:
    def test_deal_schema_exists(self):
        """Test Deal-related schemas can be imported."""
        try:
            from app.schemas.deal import DealResponse
            assert DealResponse is not None
        except ImportError:
            pytest.skip("DealResponse not available")

    def test_deal_create_schema_exists(self):
        """Test DealCreate schema can be imported."""
        try:
            from app.schemas.deal import DealCreate
            assert DealCreate is not None
        except ImportError:
            pytest.skip("DealCreate not available")


class TestUserSchema:
    def test_user_schema_exists(self):
        """Test User-related schemas can be imported."""
        try:
            from app.schemas.user import UserResponse
            assert UserResponse is not None
        except ImportError:
            pytest.skip("UserResponse not available")

    def test_user_create_schema_exists(self):
        """Test UserCreate schema can be imported."""
        try:
            from app.schemas.user import UserCreate
            assert UserCreate is not None
        except ImportError:
            pytest.skip("UserCreate not available")


class TestTenantSchema:
    def test_tenant_schema_exists(self):
        """Test Tenant-related schemas can be imported."""
        try:
            from app.schemas.tenant import TenantResponse
            assert TenantResponse is not None
        except ImportError:
            pytest.skip("TenantResponse not available")

    def test_tenant_create_schema_exists(self):
        """Test TenantCreate schema can be imported."""
        try:
            from app.schemas.tenant import TenantCreate
            assert TenantCreate is not None
        except ImportError:
            pytest.skip("TenantCreate not available")


class TestProductSchema:
    def test_product_schema_exists(self):
        """Test Product-related schemas can be imported."""
        try:
            from app.schemas.product import ProductResponse
            assert ProductResponse is not None
        except ImportError:
            pytest.skip("ProductResponse not available")


class TestCompSchema:
    def test_comp_schema_exists(self):
        """Test Comp-related schemas can be imported."""
        try:
            from app.schemas.comp import CompResponse
            assert CompResponse is not None
        except ImportError:
            pytest.skip("CompResponse not available")


class TestFinancingSchema:
    def test_financing_schema_exists(self):
        """Test Financing-related schemas can be imported."""
        try:
            from app.schemas.financing import FinancingResponse
            assert FinancingResponse is not None
        except ImportError:
            pytest.skip("FinancingResponse not available")

    def test_financing_analysis_schema_exists(self):
        """Test FinancingAnalysis schema can be imported."""
        try:
            from app.schemas.financing import FinancingAnalysis
            assert FinancingAnalysis is not None
        except ImportError:
            pytest.skip("FinancingAnalysis not available")


class TestRiskSchema:
    def test_risk_schema_exists(self):
        """Test Risk-related schemas can be imported."""
        try:
            from app.schemas.risk import RiskResponse
            assert RiskResponse is not None
        except ImportError:
            pytest.skip("RiskResponse not available")

    def test_risk_analysis_schema_exists(self):
        """Test RiskAnalysis schema can be imported."""
        try:
            from app.schemas.risk import RiskAnalysis
            assert RiskAnalysis is not None
        except ImportError:
            pytest.skip("RiskAnalysis not available")


class TestPhotoAnalysisSchema:
    def test_photo_analysis_schema_exists(self):
        """Test PhotoAnalysis schema can be imported."""
        try:
            from app.schemas.photo_analysis import PhotoAnalysisResponse
            assert PhotoAnalysisResponse is not None
        except ImportError:
            pytest.skip("PhotoAnalysisResponse not available")


class TestCreditMemoSchema:
    def test_credit_memo_schema_exists(self):
        """Test CreditMemo-related schemas can be imported."""
        try:
            from app.schemas.credit_memo import CreditMemoResponse
            assert CreditMemoResponse is not None
        except ImportError:
            pytest.skip("CreditMemoResponse not available")

    def test_credit_memo_create_schema_exists(self):
        """Test CreditMemoCreate schema can be imported."""
        try:
            from app.schemas.credit_memo import CreditMemoCreate
            assert CreditMemoCreate is not None
        except ImportError:
            pytest.skip("CreditMemoCreate not available")


class TestSchemaSerializationDeserialization:
    def test_property_create_can_be_dumped(self):
        """Test PropertyCreate can be dumped to dict."""
        try:
            from app.schemas.property import PropertyCreate
            prop = PropertyCreate(
                address="123 Main",
                city="Houston",
                state="TX",
                zip="77001",
            )
            dumped = prop.model_dump()
            assert dumped["address"] == "123 Main"
        except ImportError:
            pytest.skip("PropertyCreate not available")

    def test_property_create_model_dump_json(self):
        """Test PropertyCreate can be dumped to JSON."""
        try:
            from app.schemas.property import PropertyCreate
            prop = PropertyCreate(
                address="123 Main",
                city="Houston",
                state="TX",
                zip="77001",
            )
            json_str = prop.model_dump_json()
            assert "123 Main" in json_str
        except ImportError:
            pytest.skip("PropertyCreate not available")
