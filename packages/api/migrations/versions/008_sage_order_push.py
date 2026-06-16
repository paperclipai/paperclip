"""Add order line items, order status history, and D365 fields for Sprint 1.9.

Revision ID: 008
Revises: 007
Create Date: 2026-04-15
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "008_sage_order_push"
down_revision = "007_quote_builder"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Enhance orders table with delivery/tracking fields
    op.add_column(
        "orders",
        sa.Column("property_id", postgresql.UUID(as_uuid=False), nullable=True),
    )
    op.create_foreign_key(
        "fk_orders_property_id",
        "orders",
        "properties",
        ["property_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "orders",
        sa.Column("sage_confirmation", sa.String(255), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column("d365_opportunity_url", sa.String(1000), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column("submission_method", sa.String(20), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column("error_message", sa.Text(), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "orders",
        sa.Column("total_amount", sa.Numeric(12, 2), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column("shipped_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "orders",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.add_column(
        "orders",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_orders_status", "orders", ["status"])
    op.create_index("ix_orders_tenant_id", "orders", ["tenant_id"])

    # Order line items — snapshot of quote items at time of order
    op.create_table(
        "order_line_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            primary_key=True,
        ),
        sa.Column(
            "order_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("orders.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "quote_item_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("quote_items.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("room", sa.String(100), nullable=True),
        sa.Column("trade_category", sa.String(100), nullable=True),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("sage_sku", sa.String(100), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("unit_cost", sa.Numeric(10, 2), nullable=True),
        sa.Column("labor_cost", sa.Numeric(10, 2), nullable=True),
        sa.Column("markup_pct", sa.Numeric(5, 2), nullable=True),
        sa.Column("subtotal", sa.Numeric(12, 2), nullable=True),
        sa.Column("sage_line_id", sa.String(255), nullable=True),
        sa.Column("unit_of_measure", sa.String(50), nullable=True),
    )
    op.create_index("ix_order_line_items_order_id", "order_line_items", ["order_id"])

    # Order status history — audit trail
    op.create_table(
        "order_status_history",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            primary_key=True,
        ),
        sa.Column(
            "order_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("orders.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("from_status", sa.String(50), nullable=True),
        sa.Column("to_status", sa.String(50), nullable=False),
        sa.Column("changed_by", sa.String(255), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_order_status_history_order_id", "order_status_history", ["order_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_order_status_history_order_id", table_name="order_status_history")
    op.drop_table("order_status_history")
    op.drop_index("ix_order_line_items_order_id", table_name="order_line_items")
    op.drop_table("order_line_items")
    op.drop_index("ix_orders_tenant_id", table_name="orders")
    op.drop_index("ix_orders_status", table_name="orders")
    op.drop_column("orders", "updated_at")
    op.drop_column("orders", "created_at")
    op.drop_column("orders", "delivered_at")
    op.drop_column("orders", "shipped_at")
    op.drop_column("orders", "confirmed_at")
    op.drop_column("orders", "total_amount")
    op.drop_column("orders", "retry_count")
    op.drop_column("orders", "error_message")
    op.drop_column("orders", "submission_method")
    op.drop_column("orders", "d365_opportunity_url")
    op.drop_column("orders", "sage_confirmation")
    op.drop_constraint("fk_orders_property_id", "orders", type_="foreignkey")
    op.drop_column("orders", "property_id")
