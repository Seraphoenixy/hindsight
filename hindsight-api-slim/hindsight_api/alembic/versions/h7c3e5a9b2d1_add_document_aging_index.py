"""Add partial index on documents for document text aging sweep.

Revision ID: h7c3e5a9b2d1
Revises: g5b2d4e8f1a3
Create Date: 2026-11-26
"""

from collections.abc import Sequence

from alembic import context, op

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "h7c3e5a9b2d1"
down_revision: str | Sequence[str] | None = "g5b2d4e8f1a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _get_schema_prefix() -> str:
    """Get schema prefix for table names (required for multi-tenant support)."""
    schema = context.config.get_main_option("target_schema")
    return f'"{schema}".' if schema else ""


def _pg_upgrade() -> None:
    """Add partial index covering unpruned documents ordered by age."""
    schema = _get_schema_prefix()
    op.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_documents_aging
        ON {schema}documents (bank_id, updated_at)
        WHERE original_text IS NOT NULL
        """
    )


def _pg_downgrade() -> None:
    """Remove partial index for document text aging."""
    schema = _get_schema_prefix()
    op.execute(f"DROP INDEX IF EXISTS {schema}idx_documents_aging")


def upgrade() -> None:
    run_for_dialect(pg=_pg_upgrade)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade)
