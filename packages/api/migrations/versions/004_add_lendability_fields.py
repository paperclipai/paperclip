"""Add lendability_score and lendability_category to properties.

Revision ID: 004_add_lendability_fields
Revises: 003_comps_engine_tables
Create Date: 2026-04-13
"""

from alembic import op
import sqlalchemy as sa

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------

revision = "004_add_lendability_fields"
down_revision = "003_comps_engine_tables"
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------


def upgrade() -> None:
    op.add_column(
        "properties",
        sa.Column("lendability_score", sa.Integer(), nullable=True),
    )
    op.add_column(
        "properties",
        sa.Column("lendability_category", sa.String(20), nullable=True),
    )


# ---------------------------------------------------------------------------
# Downgrade
# ---------------------------------------------------------------------------


def downgrade() -> None:
    op.drop_column("properties", "lendability_category")
    op.drop_column("properties", "lendability_score")
