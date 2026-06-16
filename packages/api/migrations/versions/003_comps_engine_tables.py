"""Add comps engine tables — enhance comps, add rental_comps and arv_calculations.

Revision ID: 003_comps_engine_tables
Revises: 002_property_ingestion
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------

revision = "003_comps_engine_tables"
down_revision = "002_property_ingestion"
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------


def upgrade() -> None:
    # --- Enhance existing comps table with additional fields ---
    op.add_column("comps", sa.Column("city", sa.String(100), nullable=True))
    op.add_column("comps", sa.Column("state", sa.String(50), nullable=True))
    op.add_column("comps", sa.Column("zip", sa.String(20), nullable=True))
    op.add_column("comps", sa.Column("lat", sa.Float(), nullable=True))
    op.add_column("comps", sa.Column("lng", sa.Float(), nullable=True))
    op.add_column("comps", sa.Column("beds", sa.Integer(), nullable=True))
    op.add_column("comps", sa.Column("baths", sa.Float(), nullable=True))
    op.add_column("comps", sa.Column("year_built", sa.Integer(), nullable=True))
    op.add_column("comps", sa.Column("property_type", sa.String(100), nullable=True))
    op.add_column("comps", sa.Column("mls_id", sa.String(100), nullable=True))
    op.add_column("comps", sa.Column("propstream_id", sa.String(255), nullable=True))
    op.add_column(
        "comps",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # --- Create rental_comps table ---
    op.create_table(
        "rental_comps",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "property_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("properties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("address", sa.String(500), nullable=False),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("state", sa.String(50), nullable=True),
        sa.Column("zip", sa.String(20), nullable=True),
        sa.Column("lat", sa.Float(), nullable=True),
        sa.Column("lng", sa.Float(), nullable=True),
        sa.Column("rent_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("sqft", sa.Integer(), nullable=True),
        sa.Column("beds", sa.Integer(), nullable=True),
        sa.Column("baths", sa.Float(), nullable=True),
        sa.Column("property_type", sa.String(100), nullable=True),
        sa.Column("distance", sa.Float(), nullable=True),
        sa.Column("correlation", sa.Float(), nullable=True),
        sa.Column("source", sa.String(100), nullable=False, server_default="rentcast"),
        sa.Column("last_seen_date", sa.Date(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # --- Create arv_calculations table ---
    op.create_table(
        "arv_calculations",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "property_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("properties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("arv_low", sa.Numeric(12, 2), nullable=False),
        sa.Column("arv_mid", sa.Numeric(12, 2), nullable=False),
        sa.Column("arv_high", sa.Numeric(12, 2), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("comp_count", sa.Integer(), nullable=False),
        sa.Column("methodology", sa.JSON(), nullable=True),
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
    op.drop_table("arv_calculations")
    op.drop_table("rental_comps")

    op.drop_column("comps", "created_at")
    op.drop_column("comps", "propstream_id")
    op.drop_column("comps", "mls_id")
    op.drop_column("comps", "property_type")
    op.drop_column("comps", "year_built")
    op.drop_column("comps", "baths")
    op.drop_column("comps", "beds")
    op.drop_column("comps", "lng")
    op.drop_column("comps", "lat")
    op.drop_column("comps", "zip")
    op.drop_column("comps", "state")
    op.drop_column("comps", "city")
