"""Initial schema — create all tables.

Revision ID: 001_initial_schema
Revises:
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------

revision = "001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------


def upgrade() -> None:
    # ------------------------------------------------------------------
    # tenants
    # ------------------------------------------------------------------
    op.create_table(
        "tenants",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(100), nullable=False),
        sa.Column("plan", sa.String(50), nullable=False, server_default="free"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("slug", name="uq_tenants_slug"),
    )

    # ------------------------------------------------------------------
    # users
    # ------------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("clerk_id", sa.String(255), nullable=False),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("role", sa.String(50), nullable=False, server_default="member"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("clerk_id", name="uq_users_clerk_id"),
    )

    # ------------------------------------------------------------------
    # properties
    # ------------------------------------------------------------------
    op.create_table(
        "properties",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("address", sa.String(500), nullable=False),
        sa.Column("city", sa.String(100), nullable=False),
        sa.Column("state", sa.String(50), nullable=False),
        sa.Column("zip", sa.String(20), nullable=False),
        sa.Column("county", sa.String(100), nullable=True),
        sa.Column("lat", sa.Float, nullable=True),
        sa.Column("lng", sa.Float, nullable=True),
        sa.Column("year_built", sa.Integer, nullable=True),
        sa.Column("sqft", sa.Integer, nullable=True),
        sa.Column("lot_sqft", sa.Integer, nullable=True),
        sa.Column("beds", sa.Integer, nullable=True),
        sa.Column("baths", sa.Float, nullable=True),
        sa.Column("property_type", sa.String(100), nullable=True),
        sa.Column("zillow_url", sa.String(1000), nullable=True),
        sa.Column("propstream_id", sa.String(255), nullable=True),
        sa.Column("listing_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("arv_estimate", sa.Numeric(12, 2), nullable=True),
        sa.Column("arv_confidence", sa.Float, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # ------------------------------------------------------------------
    # deals
    # ------------------------------------------------------------------
    op.create_table(
        "deals",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "property_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("properties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(50), nullable=False, server_default="prospect"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # ------------------------------------------------------------------
    # comps
    # ------------------------------------------------------------------
    op.create_table(
        "comps",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "property_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("properties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("address", sa.String(500), nullable=False),
        sa.Column("sale_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("sale_date", sa.Date, nullable=True),
        sa.Column("sqft", sa.Integer, nullable=True),
        sa.Column("distance", sa.Float, nullable=True),
        sa.Column("similarity", sa.Float, nullable=True),
        sa.Column("source", sa.String(100), nullable=True),
    )

    # ------------------------------------------------------------------
    # image_captures
    # ------------------------------------------------------------------
    op.create_table(
        "image_captures",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "deal_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("deals.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("room", sa.String(100), nullable=True),
        sa.Column("shot_type", sa.String(100), nullable=True),
        sa.Column("s3_key", sa.String(1000), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # ------------------------------------------------------------------
    # image_analyses
    # ------------------------------------------------------------------
    op.create_table(
        "image_analyses",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "capture_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("image_captures.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("labels", sa.JSON, nullable=True),
        sa.Column("conditions", sa.JSON, nullable=True),
        sa.Column("confidence", sa.Float, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # ------------------------------------------------------------------
    # walk_sessions
    # ------------------------------------------------------------------
    op.create_table(
        "walk_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "deal_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("deals.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("room_count", sa.Integer, nullable=True),
    )

    # ------------------------------------------------------------------
    # quotes
    # ------------------------------------------------------------------
    op.create_table(
        "quotes",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "deal_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("deals.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(50), nullable=False, server_default="draft"),
        sa.Column("total_material", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_labor", sa.Numeric(12, 2), nullable=True),
        sa.Column("platform_fee", sa.Numeric(12, 2), nullable=True),
        sa.Column("grand_total", sa.Numeric(12, 2), nullable=True),
        sa.Column("pdf_s3_key", sa.String(1000), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # ------------------------------------------------------------------
    # quote_items
    # ------------------------------------------------------------------
    op.create_table(
        "quote_items",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "quote_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("quotes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("room", sa.String(100), nullable=True),
        sa.Column("trade_category", sa.String(100), nullable=True),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("sage_sku", sa.String(100), nullable=True),
        sa.Column("quantity", sa.Integer, nullable=True),
        sa.Column("unit_cost", sa.Numeric(10, 2), nullable=True),
        sa.Column("labor_cost", sa.Numeric(10, 2), nullable=True),
        sa.Column("subtotal", sa.Numeric(12, 2), nullable=True),
    )

    # ------------------------------------------------------------------
    # sage_catalog
    # ------------------------------------------------------------------
    op.create_table(
        "sage_catalog",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("sku", sa.String(100), nullable=False),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("unit_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("unit", sa.String(50), nullable=True),
        sa.Column("supplier", sa.String(255), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("sku", name="uq_sage_catalog_sku"),
    )

    # ------------------------------------------------------------------
    # trade_partners
    # ------------------------------------------------------------------
    op.create_table(
        "trade_partners",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("company_name", sa.String(255), nullable=False),
        sa.Column("trade", sa.String(100), nullable=True),
        sa.Column("contact_name", sa.String(255), nullable=True),
        sa.Column("phone", sa.String(50), nullable=True),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column("rating", sa.Float, nullable=True),
    )

    # ------------------------------------------------------------------
    # risk_flags
    # ------------------------------------------------------------------
    op.create_table(
        "risk_flags",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "property_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("properties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("flag_type", sa.String(100), nullable=True),
        sa.Column("severity", sa.String(50), nullable=True),
        sa.Column("detail", sa.Text, nullable=True),
        sa.Column("source", sa.String(100), nullable=True),
    )

    # ------------------------------------------------------------------
    # orders
    # ------------------------------------------------------------------
    op.create_table(
        "orders",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "quote_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("quotes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sage_order_id", sa.String(255), nullable=True),
        sa.Column("d365_opportunity_id", sa.String(255), nullable=True),
        sa.Column("status", sa.String(50), nullable=False, server_default="pending"),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ------------------------------------------------------------------
    # platform_fees
    # ------------------------------------------------------------------
    op.create_table(
        "platform_fees",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "order_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("orders.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("fee_type", sa.String(100), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


# ---------------------------------------------------------------------------
# Downgrade
# ---------------------------------------------------------------------------


def downgrade() -> None:
    # Drop in reverse dependency order
    op.drop_table("platform_fees")
    op.drop_table("orders")
    op.drop_table("risk_flags")
    op.drop_table("trade_partners")
    op.drop_table("sage_catalog")
    op.drop_table("quote_items")
    op.drop_table("quotes")
    op.drop_table("walk_sessions")
    op.drop_table("image_analyses")
    op.drop_table("image_captures")
    op.drop_table("comps")
    op.drop_table("deals")
    op.drop_table("properties")
    op.drop_table("users")
    op.drop_table("tenants")
