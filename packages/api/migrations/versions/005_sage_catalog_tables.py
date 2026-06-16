"""Add product_categories, products, and product_prices tables; drop sage_catalog.

Revision ID: 005_sage_catalog_tables
Revises: 004_add_lendability_fields
Create Date: 2026-04-14
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------

revision = "005_sage_catalog_tables"
down_revision = "004_add_lendability_fields"
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------


def upgrade() -> None:
    # -- product_categories (self-referential tree) --
    op.create_table(
        "product_categories",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "parent_id",
            UUID(as_uuid=False),
            sa.ForeignKey("product_categories.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("sage_category_id", sa.String(255), nullable=True),
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

    # -- products --
    op.create_table(
        "products",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "tenant_id",
            UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "category_id",
            UUID(as_uuid=False),
            sa.ForeignKey("product_categories.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("sage_product_id", sa.String(255), nullable=True),
        sa.Column("sku", sa.String(100), nullable=False),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("brand", sa.String(255), nullable=True),
        sa.Column("unit_of_measure", sa.String(50), nullable=True),
        sa.Column("dimensions", sa.JSON(), nullable=True),
        sa.Column("image_url", sa.String(1000), nullable=True),
        sa.Column(
            "availability_status",
            sa.String(20),
            nullable=False,
            server_default="in_stock",
        ),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.UniqueConstraint("tenant_id", "sku", name="uq_products_tenant_sku"),
    )
    op.create_index("ix_products_sku", "products", ["sku"])
    op.create_index("ix_products_category_id", "products", ["category_id"])
    op.create_index("ix_products_tenant_id", "products", ["tenant_id"])

    # -- product_prices (append-only) --
    op.create_table(
        "product_prices",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "product_id",
            UUID(as_uuid=False),
            sa.ForeignKey("products.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("price_cents", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("effective_date", sa.Date(), nullable=False),
        sa.Column("source", sa.String(50), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_product_prices_product_id", "product_prices", ["product_id"])
    op.create_index(
        "ix_product_prices_effective_date", "product_prices", ["effective_date"]
    )

    # -- drop legacy sage_catalog table --
    op.drop_table("sage_catalog")


# ---------------------------------------------------------------------------
# Downgrade
# ---------------------------------------------------------------------------


def downgrade() -> None:
    # recreate legacy sage_catalog
    op.create_table(
        "sage_catalog",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column("sku", sa.String(100), nullable=False, unique=True),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("unit_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("unit", sa.String(50), nullable=True),
        sa.Column("supplier", sa.String(255), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.drop_index("ix_product_prices_effective_date", table_name="product_prices")
    op.drop_index("ix_product_prices_product_id", table_name="product_prices")
    op.drop_table("product_prices")

    op.drop_index("ix_products_tenant_id", table_name="products")
    op.drop_index("ix_products_category_id", table_name="products")
    op.drop_index("ix_products_sku", table_name="products")
    op.drop_table("products")

    op.drop_table("product_categories")
