import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.utcnow()


# ---------------------------------------------------------------------------
# Tenants
# ---------------------------------------------------------------------------


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    plan: Mapped[str] = mapped_column(String(50), nullable=False, default="free")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    users: Mapped[list["User"]] = relationship("User", back_populates="tenant")
    properties: Mapped[list["Property"]] = relationship("Property", back_populates="tenant")
    deals: Mapped[list["Deal"]] = relationship("Deal", back_populates="tenant")
    quotes: Mapped[list["Quote"]] = relationship("Quote", back_populates="tenant")
    trade_partners: Mapped[list["TradePartner"]] = relationship(
        "TradePartner", back_populates="tenant"
    )
    orders: Mapped[list["Order"]] = relationship("Order", back_populates="tenant")
    products: Mapped[list["Product"]] = relationship("Product", back_populates="tenant")


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    clerk_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    tenant_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True
    )
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="member")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    tenant: Mapped["Tenant | None"] = relationship("Tenant", back_populates="users")


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------


class Property(Base):
    __tablename__ = "properties"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    address: Mapped[str] = mapped_column(String(500), nullable=False)
    city: Mapped[str] = mapped_column(String(100), nullable=False)
    state: Mapped[str] = mapped_column(String(50), nullable=False)
    zip: Mapped[str] = mapped_column(String(20), nullable=False)
    county: Mapped[str | None] = mapped_column(String(100), nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    year_built: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sqft: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lot_sqft: Mapped[int | None] = mapped_column(Integer, nullable=True)
    beds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    baths: Mapped[float | None] = mapped_column(Float, nullable=True)
    property_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    zillow_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    propstream_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    listing_price: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    arv_estimate: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    arv_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    data_source: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ownership_history: Mapped[Any] = mapped_column(JSON, nullable=True)
    tax_assessment: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="active")
    mls_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    neighborhood: Mapped[str | None] = mapped_column(String(255), nullable=True)
    zillow_estimate: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    lendability_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lendability_category: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="properties")
    deals: Mapped[list["Deal"]] = relationship("Deal", back_populates="property")
    comps: Mapped[list["Comp"]] = relationship("Comp", back_populates="property")
    rental_comps: Mapped[list["RentalComp"]] = relationship("RentalComp", back_populates="property")
    arv_calculations: Mapped[list["ARVCalculation"]] = relationship("ARVCalculation", back_populates="property")
    risk_flags: Mapped[list["RiskFlag"]] = relationship("RiskFlag", back_populates="property")
    photo_analyses: Mapped[list["PropertyPhotoAnalysis"]] = relationship(
        "PropertyPhotoAnalysis", back_populates="property"
    )
    quotes: Mapped[list["Quote"]] = relationship("Quote", back_populates="property")


# ---------------------------------------------------------------------------
# Deals
# ---------------------------------------------------------------------------


class Deal(Base):
    __tablename__ = "deals"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    property_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("properties.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="prospect")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="deals")
    property: Mapped["Property"] = relationship("Property", back_populates="deals")
    image_captures: Mapped[list["ImageCapture"]] = relationship(
        "ImageCapture", back_populates="deal"
    )
    walk_sessions: Mapped[list["WalkSession"]] = relationship(
        "WalkSession", back_populates="deal"
    )
    quotes: Mapped[list["Quote"]] = relationship("Quote", back_populates="deal")


# ---------------------------------------------------------------------------
# Comps
# ---------------------------------------------------------------------------


class Comp(Base):
    __tablename__ = "comps"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    property_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("properties.id", ondelete="CASCADE"), nullable=False
    )
    address: Mapped[str] = mapped_column(String(500), nullable=False)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(50), nullable=True)
    zip: Mapped[str | None] = mapped_column(String(20), nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    sale_price: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    sale_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    sqft: Mapped[int | None] = mapped_column(Integer, nullable=True)
    beds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    baths: Mapped[float | None] = mapped_column(Float, nullable=True)
    year_built: Mapped[int | None] = mapped_column(Integer, nullable=True)
    property_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    distance: Mapped[float | None] = mapped_column(Float, nullable=True)
    similarity: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str | None] = mapped_column(String(100), nullable=True)
    mls_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    propstream_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    property: Mapped["Property"] = relationship("Property", back_populates="comps")


# ---------------------------------------------------------------------------
# Rental Comps
# ---------------------------------------------------------------------------


class RentalComp(Base):
    __tablename__ = "rental_comps"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    property_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("properties.id", ondelete="CASCADE"), nullable=False
    )
    address: Mapped[str] = mapped_column(String(500), nullable=False)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(50), nullable=True)
    zip: Mapped[str | None] = mapped_column(String(20), nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    rent_price: Mapped[Any] = mapped_column(Numeric(10, 2), nullable=True)
    sqft: Mapped[int | None] = mapped_column(Integer, nullable=True)
    beds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    baths: Mapped[float | None] = mapped_column(Float, nullable=True)
    property_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    distance: Mapped[float | None] = mapped_column(Float, nullable=True)
    correlation: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(100), nullable=False, default="rentcast")
    last_seen_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    property: Mapped["Property"] = relationship("Property", back_populates="rental_comps")


# ---------------------------------------------------------------------------
# ARV Calculations
# ---------------------------------------------------------------------------


class ARVCalculation(Base):
    __tablename__ = "arv_calculations"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    property_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("properties.id", ondelete="CASCADE"), nullable=False
    )
    arv_low: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=False)
    arv_mid: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=False)
    arv_high: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    comp_count: Mapped[int] = mapped_column(Integer, nullable=False)
    methodology: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    property: Mapped["Property"] = relationship("Property", back_populates="arv_calculations")


# ---------------------------------------------------------------------------
# Image Captures
# ---------------------------------------------------------------------------


class ImageCapture(Base):
    __tablename__ = "image_captures"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    deal_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("deals.id", ondelete="CASCADE"), nullable=False
    )
    room: Mapped[str | None] = mapped_column(String(100), nullable=True)
    shot_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    s3_key: Mapped[str] = mapped_column(String(1000), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    deal: Mapped["Deal"] = relationship("Deal", back_populates="image_captures")
    analyses: Mapped[list["ImageAnalysis"]] = relationship(
        "ImageAnalysis", back_populates="capture"
    )


# ---------------------------------------------------------------------------
# Image Analyses
# ---------------------------------------------------------------------------


class ImageAnalysis(Base):
    __tablename__ = "image_analyses"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    capture_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("image_captures.id", ondelete="CASCADE"),
        nullable=False,
    )
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    labels: Mapped[Any] = mapped_column(JSON, nullable=True)
    conditions: Mapped[Any] = mapped_column(JSON, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    capture: Mapped["ImageCapture"] = relationship("ImageCapture", back_populates="analyses")


# ---------------------------------------------------------------------------
# Walk Sessions
# ---------------------------------------------------------------------------


class WalkSession(Base):
    __tablename__ = "walk_sessions"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    deal_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("deals.id", ondelete="CASCADE"), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    room_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    deal: Mapped["Deal"] = relationship("Deal", back_populates="walk_sessions")


# ---------------------------------------------------------------------------
# Quotes
# ---------------------------------------------------------------------------


class Quote(Base):
    __tablename__ = "quotes"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    deal_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("deals.id", ondelete="CASCADE"), nullable=False
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    property_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("properties.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    photo_analysis_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("property_photo_analyses.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="draft")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    total_material: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    total_labor: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    platform_fee: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    platform_fee_pct: Mapped[Any] = mapped_column(Numeric(5, 4), nullable=True)
    tax_amount: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    grand_total: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    pdf_s3_key: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    deal: Mapped["Deal"] = relationship("Deal", back_populates="quotes")
    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="quotes")
    property: Mapped["Property | None"] = relationship("Property", back_populates="quotes")
    photo_analysis: Mapped["PropertyPhotoAnalysis | None"] = relationship(
        "PropertyPhotoAnalysis", back_populates="quotes"
    )
    items: Mapped[list["QuoteItem"]] = relationship(
        "QuoteItem", back_populates="quote", cascade="all, delete-orphan"
    )
    orders: Mapped[list["Order"]] = relationship("Order", back_populates="quote")


# ---------------------------------------------------------------------------
# Quote Items
# ---------------------------------------------------------------------------


class QuoteItem(Base):
    __tablename__ = "quote_items"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    quote_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False
    )
    room: Mapped[str | None] = mapped_column(String(100), nullable=True)
    trade_category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sage_sku: Mapped[str | None] = mapped_column(String(100), nullable=True)
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unit_cost: Mapped[Any] = mapped_column(Numeric(10, 2), nullable=True)
    labor_cost: Mapped[Any] = mapped_column(Numeric(10, 2), nullable=True)
    markup_pct: Mapped[Any] = mapped_column(Numeric(5, 2), nullable=True)
    subtotal: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    ai_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_ai_generated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    unit_of_measure: Mapped[str | None] = mapped_column(String(50), nullable=True)

    quote: Mapped["Quote"] = relationship("Quote", back_populates="items")


# ---------------------------------------------------------------------------
# Product Categories
# ---------------------------------------------------------------------------


class ProductCategory(Base):
    __tablename__ = "product_categories"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("product_categories.id", ondelete="SET NULL"),
        nullable=True,
    )
    sage_category_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    parent: Mapped["ProductCategory | None"] = relationship(
        "ProductCategory", back_populates="children", remote_side="ProductCategory.id"
    )
    children: Mapped[list["ProductCategory"]] = relationship(
        "ProductCategory", back_populates="parent"
    )
    products: Mapped[list["Product"]] = relationship("Product", back_populates="category")


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------


class Product(Base):
    __tablename__ = "products"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    category_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("product_categories.id", ondelete="SET NULL"),
        nullable=True,
    )
    sage_product_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sku: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    brand: Mapped[str | None] = mapped_column(String(255), nullable=True)
    unit_of_measure: Mapped[str | None] = mapped_column(String(50), nullable=True)
    dimensions: Mapped[Any] = mapped_column(JSON, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    availability_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="in_stock"
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("tenant_id", "sku", name="uq_products_tenant_sku"),
    )

    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="products")
    category: Mapped["ProductCategory | None"] = relationship(
        "ProductCategory", back_populates="products"
    )
    prices: Mapped[list["ProductPrice"]] = relationship(
        "ProductPrice", back_populates="product"
    )


# ---------------------------------------------------------------------------
# Product Prices (append-only history)
# ---------------------------------------------------------------------------


class ProductPrice(Base):
    __tablename__ = "product_prices"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    product_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
    )
    price_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    effective_date: Mapped[date] = mapped_column(Date, nullable=False)
    source: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    product: Mapped["Product"] = relationship("Product", back_populates="prices")


# ---------------------------------------------------------------------------
# Trade Partners
# ---------------------------------------------------------------------------


class TradePartner(Base):
    __tablename__ = "trade_partners"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    company_name: Mapped[str] = mapped_column(String(255), nullable=False)
    trade: Mapped[str | None] = mapped_column(String(100), nullable=True)
    contact_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)

    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="trade_partners")


# ---------------------------------------------------------------------------
# Risk Flags
# ---------------------------------------------------------------------------


class RiskFlag(Base):
    __tablename__ = "risk_flags"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    property_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("properties.id", ondelete="CASCADE"), nullable=False
    )
    flag_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    severity: Mapped[str | None] = mapped_column(String(50), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str | None] = mapped_column(String(100), nullable=True)

    property: Mapped["Property"] = relationship("Property", back_populates="risk_flags")


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    quote_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    property_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("properties.id", ondelete="SET NULL"),
        nullable=True,
    )
    sage_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sage_confirmation: Mapped[str | None] = mapped_column(String(255), nullable=True)
    d365_opportunity_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    d365_opportunity_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="pending")
    submission_method: Mapped[str | None] = mapped_column(String(20), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_amount: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    shipped_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    delivered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    quote: Mapped["Quote"] = relationship("Quote", back_populates="orders")
    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="orders")
    property: Mapped["Property | None"] = relationship("Property")
    platform_fees: Mapped[list["PlatformFee"]] = relationship(
        "PlatformFee", back_populates="order"
    )
    line_items: Mapped[list["OrderLineItem"]] = relationship(
        "OrderLineItem", back_populates="order", cascade="all, delete-orphan"
    )
    status_history: Mapped[list["OrderStatusHistory"]] = relationship(
        "OrderStatusHistory", back_populates="order", cascade="all, delete-orphan"
    )


# ---------------------------------------------------------------------------
# Platform Fees
# ---------------------------------------------------------------------------


class PlatformFee(Base):
    __tablename__ = "platform_fees"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    order_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    amount: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    fee_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    order: Mapped["Order"] = relationship("Order", back_populates="platform_fees")


# ---------------------------------------------------------------------------
# Property Photo Analyses
# ---------------------------------------------------------------------------


class PropertyPhotoAnalysis(Base):
    __tablename__ = "property_photo_analyses"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    property_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("properties.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        String(30), nullable=False, default="pending"
    )
    photo_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    model_id: Mapped[str] = mapped_column(String(100), nullable=False)
    renovation_signal: Mapped[str | None] = mapped_column(String(30), nullable=True)
    renovation_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_cost_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    property: Mapped["Property"] = relationship(
        "Property", back_populates="photo_analyses"
    )
    labels: Mapped[list["PhotoLabel"]] = relationship(
        "PhotoLabel", back_populates="analysis"
    )
    quotes: Mapped[list["Quote"]] = relationship(
        "Quote", back_populates="photo_analysis"
    )


# ---------------------------------------------------------------------------
# Photo Labels
# ---------------------------------------------------------------------------


class PhotoLabel(Base):
    __tablename__ = "photo_labels"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    analysis_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("property_photo_analyses.id", ondelete="CASCADE"),
        nullable=False,
    )
    photo_url: Mapped[str] = mapped_column(String(2000), nullable=False)
    photo_index: Mapped[int] = mapped_column(Integer, nullable=False)
    room_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    condition: Mapped[str | None] = mapped_column(String(50), nullable=True)
    damage_issues: Mapped[Any] = mapped_column(JSON, nullable=True)
    renovation_needed: Mapped[str | None] = mapped_column(String(30), nullable=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    confidence_tier: Mapped[str] = mapped_column(
        String(10), nullable=False, default="medium"
    )
    raw_response: Mapped[Any] = mapped_column(JSON, nullable=True)
    review_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="auto_accepted"
    )
    reviewer_override: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    analysis: Mapped["PropertyPhotoAnalysis"] = relationship(
        "PropertyPhotoAnalysis", back_populates="labels"
    )


# ---------------------------------------------------------------------------
# Order Line Items (snapshot of quote items at order time)
# ---------------------------------------------------------------------------


class OrderLineItem(Base):
    __tablename__ = "order_line_items"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    order_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    quote_item_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("quote_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    room: Mapped[str | None] = mapped_column(String(100), nullable=True)
    trade_category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sage_sku: Mapped[str | None] = mapped_column(String(100), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    unit_cost: Mapped[Any] = mapped_column(Numeric(10, 2), nullable=True)
    labor_cost: Mapped[Any] = mapped_column(Numeric(10, 2), nullable=True)
    markup_pct: Mapped[Any] = mapped_column(Numeric(5, 2), nullable=True)
    subtotal: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    sage_line_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    unit_of_measure: Mapped[str | None] = mapped_column(String(50), nullable=True)

    order: Mapped["Order"] = relationship("Order", back_populates="line_items")


# ---------------------------------------------------------------------------
# Order Status History
# ---------------------------------------------------------------------------


class OrderStatusHistory(Base):
    __tablename__ = "order_status_history"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=_uuid
    )
    order_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    from_status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    to_status: Mapped[str] = mapped_column(String(50), nullable=False)
    changed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    order: Mapped["Order"] = relationship("Order", back_populates="status_history")


# ---------------------------------------------------------------------------
# Credit Memos
# ---------------------------------------------------------------------------


class CreditMemo(Base):
    __tablename__ = "credit_memos"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Enum values enforced at the application/schema layer; stored as VARCHAR for
    # forward-compatibility if new codes are added before a migration.
    cause_code: Mapped[str] = mapped_column(String(50), nullable=False)
    job_key: Mapped[str] = mapped_column(String(255), nullable=False)
    qc_stage: Mapped[str] = mapped_column(String(50), nullable=False)
    # Nullable: no source in current Order/OrderLineItem data; captured for future backfill.
    rsm_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    territory_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Derived from first OrderLineItem.trade_category on job# lookup; manual otherwise.
    product_tier: Mapped[str | None] = mapped_column(String(100), nullable=True)
    amount: Mapped[Any] = mapped_column(Numeric(12, 2), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    tenant: Mapped["Tenant"] = relationship("Tenant")
