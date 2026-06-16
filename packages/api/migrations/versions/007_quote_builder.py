"""Add quote builder columns for Sprint 1.8.

Revision ID: 007
Revises: 006
Create Date: 2026-04-14
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "007_quote_builder"
down_revision = "006_photo_analysis_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add property_id and photo_analysis_id to quotes for direct linkage
    op.add_column(
        "quotes",
        sa.Column(
            "property_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("properties.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "quotes",
        sa.Column(
            "photo_analysis_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("property_photo_analyses.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "quotes",
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "quotes",
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.add_column(
        "quotes",
        sa.Column("tax_amount", sa.Numeric(12, 2), nullable=True),
    )
    op.add_column(
        "quotes",
        sa.Column("platform_fee_pct", sa.Numeric(5, 4), nullable=True),
    )

    op.create_index("ix_quotes_property_id", "quotes", ["property_id"])
    op.create_index("ix_quotes_status", "quotes", ["status"])

    # Enhance quote_items for AI generation and markup
    op.add_column(
        "quote_items",
        sa.Column("markup_pct", sa.Numeric(5, 2), nullable=True),
    )
    op.add_column(
        "quote_items",
        sa.Column("ai_confidence", sa.Float(), nullable=True),
    )
    op.add_column(
        "quote_items",
        sa.Column(
            "is_ai_generated",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )
    op.add_column(
        "quote_items",
        sa.Column("unit_of_measure", sa.String(50), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("quote_items", "unit_of_measure")
    op.drop_column("quote_items", "is_ai_generated")
    op.drop_column("quote_items", "ai_confidence")
    op.drop_column("quote_items", "markup_pct")
    op.drop_index("ix_quotes_status", table_name="quotes")
    op.drop_index("ix_quotes_property_id", table_name="quotes")
    op.drop_column("quotes", "platform_fee_pct")
    op.drop_column("quotes", "tax_amount")
    op.drop_column("quotes", "notes")
    op.drop_column("quotes", "version")
    op.drop_column("quotes", "photo_analysis_id")
    op.drop_column("quotes", "property_id")
