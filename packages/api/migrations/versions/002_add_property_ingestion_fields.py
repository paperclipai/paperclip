"""Add property ingestion fields — data_source, ownership_history, tax_assessment, status, mls_id, neighborhood, zillow_estimate.

Revision ID: 002_property_ingestion
Revises: 001_initial_schema
Create Date: 2026-04-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------

revision = "002_property_ingestion"
down_revision = "001_initial_schema"
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------


def upgrade() -> None:
    op.add_column("properties", sa.Column("data_source", sa.String(100), nullable=True))
    op.add_column("properties", sa.Column("ownership_history", sa.JSON(), nullable=True))
    op.add_column("properties", sa.Column("tax_assessment", sa.Numeric(12, 2), nullable=True))
    op.add_column(
        "properties",
        sa.Column("status", sa.String(50), nullable=False, server_default="active"),
    )
    op.add_column("properties", sa.Column("mls_id", sa.String(100), nullable=True))
    op.add_column("properties", sa.Column("neighborhood", sa.String(255), nullable=True))
    op.add_column("properties", sa.Column("zillow_estimate", sa.Numeric(12, 2), nullable=True))


# ---------------------------------------------------------------------------
# Downgrade
# ---------------------------------------------------------------------------


def downgrade() -> None:
    op.drop_column("properties", "zillow_estimate")
    op.drop_column("properties", "neighborhood")
    op.drop_column("properties", "mls_id")
    op.drop_column("properties", "status")
    op.drop_column("properties", "tax_assessment")
    op.drop_column("properties", "ownership_history")
    op.drop_column("properties", "data_source")
