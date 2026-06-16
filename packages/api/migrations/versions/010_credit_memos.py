"""Add credit_memos table (SAG-2805).

Purely additive CREATE TABLE — no existing data touched.
cause_code and qc_stage are stored as VARCHAR; enum enforcement is at the
application layer so new codes can be added without a schema migration.

Revision ID: 010
Revises: 008
Create Date: 2026-06-02
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "010_credit_memos"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "credit_memos",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Required fields — NOT NULL enforced here and at the application layer.
        sa.Column("cause_code", sa.String(50), nullable=False),
        sa.Column("job_key", sa.String(255), nullable=False),
        sa.Column("qc_stage", sa.String(50), nullable=False),
        # Optional / auto-populated fields — nullable, tighten later after backfill (SAG-2804).
        sa.Column("rsm_id", sa.String(255), nullable=True),
        sa.Column("territory_id", sa.String(255), nullable=True),
        sa.Column("product_tier", sa.String(100), nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(255), nullable=True),
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
    op.create_index("ix_credit_memos_tenant_id", "credit_memos", ["tenant_id"])
    op.create_index("ix_credit_memos_cause_code", "credit_memos", ["cause_code"])
    op.create_index("ix_credit_memos_job_key", "credit_memos", ["job_key"])


def downgrade() -> None:
    op.drop_index("ix_credit_memos_job_key", table_name="credit_memos")
    op.drop_index("ix_credit_memos_cause_code", table_name="credit_memos")
    op.drop_index("ix_credit_memos_tenant_id", table_name="credit_memos")
    op.drop_table("credit_memos")
