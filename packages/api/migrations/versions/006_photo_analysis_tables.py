"""Add property photo analysis, photo labels, and review queue tables.

Revision ID: 006_photo_analysis_tables
Revises: 005_sage_catalog_tables
Create Date: 2026-04-14
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------

revision = "006_photo_analysis_tables"
down_revision = "005_sage_catalog_tables"
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------


def upgrade() -> None:
    # -- property_photo_analyses (one per property analysis run) --
    op.create_table(
        "property_photo_analyses",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "property_id",
            UUID(as_uuid=False),
            sa.ForeignKey("properties.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(30), nullable=False, server_default="pending"),
        sa.Column("photo_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("model_id", sa.String(100), nullable=False),
        sa.Column("renovation_signal", sa.String(30), nullable=True),
        sa.Column("renovation_confidence", sa.Float(), nullable=True),
        sa.Column("total_cost_cents", sa.BigInteger(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_property_photo_analyses_property_id",
        "property_photo_analyses",
        ["property_id"],
    )
    op.create_index(
        "ix_property_photo_analyses_status",
        "property_photo_analyses",
        ["status"],
    )

    # -- photo_labels (per-photo results from Claude Vision) --
    op.create_table(
        "photo_labels",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "analysis_id",
            UUID(as_uuid=False),
            sa.ForeignKey("property_photo_analyses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("photo_url", sa.String(2000), nullable=False),
        sa.Column("photo_index", sa.Integer(), nullable=False),
        sa.Column("room_type", sa.String(100), nullable=True),
        sa.Column("condition", sa.String(50), nullable=True),
        sa.Column("damage_issues", sa.JSON(), nullable=True),
        sa.Column("renovation_needed", sa.String(30), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column(
            "confidence_tier",
            sa.String(10),
            nullable=False,
            server_default="medium",
        ),
        sa.Column("raw_response", sa.JSON(), nullable=True),
        sa.Column(
            "review_status",
            sa.String(20),
            nullable=False,
            server_default="auto_accepted",
        ),
        sa.Column("reviewer_override", sa.JSON(), nullable=True),
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
    op.create_index(
        "ix_photo_labels_analysis_id", "photo_labels", ["analysis_id"]
    )
    op.create_index(
        "ix_photo_labels_review_status", "photo_labels", ["review_status"]
    )
    op.create_index(
        "ix_photo_labels_confidence_tier", "photo_labels", ["confidence_tier"]
    )


# ---------------------------------------------------------------------------
# Downgrade
# ---------------------------------------------------------------------------


def downgrade() -> None:
    op.drop_index("ix_photo_labels_confidence_tier", table_name="photo_labels")
    op.drop_index("ix_photo_labels_review_status", table_name="photo_labels")
    op.drop_index("ix_photo_labels_analysis_id", table_name="photo_labels")
    op.drop_table("photo_labels")

    op.drop_index(
        "ix_property_photo_analyses_status",
        table_name="property_photo_analyses",
    )
    op.drop_index(
        "ix_property_photo_analyses_property_id",
        table_name="property_photo_analyses",
    )
    op.drop_table("property_photo_analyses")
