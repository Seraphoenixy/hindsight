"""Allow long working rules by removing the full-text unique B-tree index.

Revision ID: f42c9a8e613b
Revises: e7a1b2c3d4f5
Create Date: 2026-11-25
"""

from collections.abc import Sequence

from alembic import context, op

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "f42c9a8e613b"
down_revision: str | Sequence[str] | None = "e7a1b2c3d4f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _pg_schema_prefix() -> str:
    schema = context.config.get_main_option("target_schema")
    return f'"{schema}".' if schema else ""


def _pg_upgrade() -> None:
    # The service checks exact duplicates under a transaction lock. Full rule
    # text can exceed PostgreSQL's B-tree key size even at the default API limit.
    op.execute(f"DROP INDEX IF EXISTS {_pg_schema_prefix()}uq_working_rules_active_content")


def _pg_downgrade() -> None:
    op.execute(f"""
        CREATE UNIQUE INDEX uq_working_rules_active_content
        ON {_pg_schema_prefix()}working_rules(scope, COALESCE(project_id, ''), content)
        WHERE is_archived = FALSE
    """)


def upgrade() -> None:
    run_for_dialect(pg=_pg_upgrade)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade)
