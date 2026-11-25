"""Add working_rules table for cross-project and project-scoped working rules.

Revision ID: e7a1b2c3d4f5
Revises: kbtok1a2b3c4
Create Date: 2026-11-24
"""

from collections.abc import Sequence

from alembic import context, op

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "e7a1b2c3d4f5"
down_revision: str | Sequence[str] | None = "kbtok1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _pg_schema_prefix() -> str:
    """Schema-qualifier for raw SQL on PG (multi-tenant search_path)."""
    schema = context.config.get_main_option("target_schema")
    return f'"{schema}".' if schema else ""


def _pg_upgrade() -> None:
    schema = _pg_schema_prefix()
    op.execute(f"""
        CREATE TABLE IF NOT EXISTS {schema}working_rules (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            scope VARCHAR(16) NOT NULL DEFAULT 'global',
            project_id TEXT,
            content TEXT NOT NULL,
            importance VARCHAR(16) NOT NULL DEFAULT 'normal',
            pinned BOOLEAN NOT NULL DEFAULT FALSE,
            branches VARCHAR[] NOT NULL DEFAULT ARRAY[]::VARCHAR[],
            is_archived BOOLEAN NOT NULL DEFAULT FALSE,
            archived_at TIMESTAMP WITH TIME ZONE,
            archive_reason VARCHAR(64),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            CONSTRAINT chk_working_rules_scope CHECK (scope IN ('global', 'project')),
            CONSTRAINT chk_working_rules_importance CHECK (importance IN ('critical', 'normal', 'low')),
            CONSTRAINT chk_working_rules_scope_project CHECK (
                (scope = 'global' AND project_id IS NULL)
                OR (scope = 'project' AND project_id IS NOT NULL AND length(trim(project_id)) > 0)
            )
        )
    """)
    op.execute(f"""
        CREATE INDEX IF NOT EXISTS idx_working_rules_active_scope
        ON {schema}working_rules(is_archived, scope, project_id)
    """)
    op.execute(f"""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_working_rules_active_content
        ON {schema}working_rules(scope, COALESCE(project_id, ''), content)
        WHERE is_archived = FALSE
    """)


def _pg_downgrade() -> None:
    schema = _pg_schema_prefix()
    op.execute(f"DROP INDEX IF EXISTS {schema}uq_working_rules_active_content")
    op.execute(f"DROP INDEX IF EXISTS {schema}idx_working_rules_active_scope")
    op.execute(f"DROP TABLE IF EXISTS {schema}working_rules CASCADE")


def _oracle_upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS working_rules (
            id              RAW(16)        DEFAULT SYS_GUID() NOT NULL,
            scope           VARCHAR2(16)   DEFAULT 'global' NOT NULL,
            project_id      VARCHAR2(512),
            content         CLOB           NOT NULL,
            importance      VARCHAR2(16)   DEFAULT 'normal' NOT NULL,
            pinned          NUMBER(1)      DEFAULT 0 NOT NULL,
            branches        CLOB           DEFAULT '[]' NOT NULL
                                           CONSTRAINT wr_branches_json CHECK (branches IS JSON),
            is_archived     NUMBER(1)      DEFAULT 0 NOT NULL,
            archived_at     TIMESTAMP WITH TIME ZONE,
            archive_reason  VARCHAR2(64),
            created_at      TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
            updated_at      TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT pk_working_rules PRIMARY KEY (id),
            CONSTRAINT chk_working_rules_scope CHECK (scope IN ('global', 'project')),
            CONSTRAINT chk_working_rules_importance CHECK (importance IN ('critical', 'normal', 'low')),
            CONSTRAINT chk_working_rules_scope_project CHECK (
                (scope = 'global' AND project_id IS NULL)
                OR (scope = 'project' AND project_id IS NOT NULL AND length(trim(project_id)) > 0)
            )
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_working_rules_active_scope
        ON working_rules(is_archived, scope, project_id)
    """)


def _oracle_downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_working_rules_active_scope")
    op.execute("DROP TABLE IF EXISTS working_rules CASCADE CONSTRAINTS")


def upgrade() -> None:
    run_for_dialect(pg=_pg_upgrade, oracle=_oracle_upgrade)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade, oracle=_oracle_downgrade)
