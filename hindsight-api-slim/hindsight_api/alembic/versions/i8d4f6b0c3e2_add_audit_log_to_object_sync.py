"""Add audit_log to v3 object-level sync change trigger.

Revision ID: i8d4f6b0c3e2
Revises: h7c3e5a9b2d1
Create Date: 2026-11-26
"""

from collections.abc import Sequence

from alembic import context, op

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "i8d4f6b0c3e2"
down_revision: str | Sequence[str] | None = "h7c3e5a9b2d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _pg_schema_prefix() -> str:
    schema = context.config.get_main_option("target_schema")
    return f'"{schema}".' if schema else ""


def _pg_upgrade() -> None:
    schema = _pg_schema_prefix()
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION {schema}_hindsight_record_sync_change()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
            v_schema TEXT := TG_TABLE_SCHEMA;
            v_obj_type TEXT;
            v_bank_id TEXT := '';
            v_obj_id TEXT;
            v_op TEXT;
            v_doc_id TEXT;
            v_fact_type TEXT;
            v_doc_exists BOOLEAN;
            v_hash TEXT := '';
            v_version BIGINT;
            v_base_ver BIGINT;
            v_seq BIGINT;
            v_was_deleted BOOLEAN;
        BEGIN
            IF current_setting('hindsight.sync_applying', true) = '1'
               OR current_setting('hindsight.sync_tx_managed', true) = '1' THEN
                RETURN NULL;
            END IF;

            IF TG_OP = 'DELETE' THEN
                v_op := 'delete';
            ELSE
                v_op := 'upsert';
            END IF;

            IF TG_TABLE_NAME = 'working_rules' THEN
                v_obj_type := 'working_rule';
                v_bank_id := '';
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
                IF TG_OP <> 'DELETE' THEN
                    v_hash := encode(sha256(convert_to(row_to_json(NEW)::text, 'UTF8')), 'hex');
                END IF;
            ELSIF TG_TABLE_NAME = 'banks' THEN
                v_obj_type := 'bank';
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_obj_id := v_bank_id;
            ELSIF TG_TABLE_NAME = 'directives' THEN
                v_obj_type := 'directive';
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
            ELSIF TG_TABLE_NAME = 'mental_models' THEN
                v_obj_type := 'mental_model';
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
            ELSIF TG_TABLE_NAME = 'knowledge_pages' THEN
                v_obj_type := 'knowledge_page';
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
            ELSIF TG_TABLE_NAME = 'documents' THEN
                IF TG_OP <> 'DELETE' AND NEW.content_hash = '__pending__' THEN
                    RETURN NULL;
                END IF;
                IF TG_OP = 'DELETE' AND OLD.content_hash = '__pending__' THEN
                    RETURN NULL;
                END IF;
                v_obj_type := 'document';
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
            ELSIF TG_TABLE_NAME = 'webhooks' THEN
                v_obj_type := 'webhook';
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
            ELSIF TG_TABLE_NAME = 'kb_documents' THEN
                v_obj_type := 'kb_document';
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
            ELSIF TG_TABLE_NAME = 'audit_log' THEN
                v_obj_type := 'audit_log';
                v_bank_id := COALESCE(CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END, '');
                v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
            ELSIF TG_TABLE_NAME IN ('memory_units', 'invalidated_memory_units') THEN
                v_bank_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bank_id ELSE NEW.bank_id END;
                v_doc_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
                v_fact_type := CASE WHEN TG_OP = 'DELETE' THEN OLD.fact_type ELSE NEW.fact_type END;
                IF v_fact_type = 'observation' THEN
                    v_obj_type := 'observation';
                    v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
                ELSIF v_doc_id IS NOT NULL THEN
                    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.documents WHERE id = $1 AND bank_id = $2)', v_schema)
                        INTO v_doc_exists USING v_doc_id, v_bank_id;
                    IF NOT v_doc_exists THEN
                        RETURN NULL;
                    END IF;
                    v_obj_type := 'document';
                    v_obj_id := v_doc_id;
                    v_op := 'upsert';
                ELSE
                    v_obj_type := 'memory_unit';
                    v_obj_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
                END IF;
            ELSE
                RETURN NULL;
            END IF;

            EXECUTE format(
                'SELECT deleted FROM %I.sync_object_state WHERE object_type = $1 AND bank_id = $2 AND object_id = $3 FOR UPDATE',
                v_schema
            ) INTO v_was_deleted USING v_obj_type, v_bank_id, v_obj_id;

            IF v_op = 'upsert' AND COALESCE(v_was_deleted, FALSE) THEN
                v_op := 'restore';
            END IF;

            EXECUTE format(
                'INSERT INTO %I.sync_object_state '
                '  (object_type, bank_id, object_id, version, base_relay_version, content_hash, deleted, deleted_at, dirty, updated_at) '
                'VALUES ($1, $2, $3, 1, 0, $4, $5, CASE WHEN $5 THEN now() ELSE NULL END, TRUE, now()) '
                'ON CONFLICT (object_type, bank_id, object_id) DO UPDATE '
                'SET version = %I.sync_object_state.version + 1, '
                '    content_hash = EXCLUDED.content_hash, '
                '    deleted = EXCLUDED.deleted, '
                '    deleted_at = CASE WHEN EXCLUDED.deleted THEN now() ELSE NULL END, '
                '    dirty = TRUE, '
                '    origin_device_id = NULL, '
                '    updated_at = now() '
                'RETURNING version, base_relay_version',
                v_schema, v_schema
            ) INTO v_version, v_base_ver USING v_obj_type, v_bank_id, v_obj_id, v_hash, (v_op = 'delete');

            EXECUTE format(
                'INSERT INTO %I.sync_change_log '
                '  (object_type, bank_id, object_id, op, version, base_relay_version, content_hash) '
                'VALUES ($1, $2, $3, $4, $5, $6, $7) '
                'RETURNING seq',
                v_schema
            ) INTO v_seq USING v_obj_type, v_bank_id, v_obj_id, v_op, v_version, v_base_ver, v_hash;

            EXECUTE format(
                'UPDATE %I.sync_object_state SET last_seq = $4 '
                'WHERE object_type = $1 AND bank_id = $2 AND object_id = $3',
                v_schema
            ) USING v_obj_type, v_bank_id, v_obj_id, v_seq;

            RETURN NULL;
        END;
        $$;
        """
    )
    op.execute(
        f"""
        DROP TRIGGER IF EXISTS trg_sync_audit_log ON {schema}audit_log;
        CREATE TRIGGER trg_sync_audit_log
        AFTER INSERT OR UPDATE OR DELETE ON {schema}audit_log
        FOR EACH ROW
        EXECUTE FUNCTION {schema}_hindsight_record_sync_change();
        """
    )


def _pg_downgrade() -> None:
    schema = _pg_schema_prefix()
    op.execute(f"DROP TRIGGER IF EXISTS trg_sync_audit_log ON {schema}audit_log")


def upgrade() -> None:
    run_for_dialect(pg=_pg_upgrade)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade)
