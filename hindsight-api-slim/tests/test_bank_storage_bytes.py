"""Integration tests for ``bank_storage_bytes`` including ``audit_log`` and ``invalidated_memory_units``."""

from __future__ import annotations

import json
import os
import uuid

import asyncpg
import pytest

from hindsight_api.engine.memories.pg.counts import bank_storage_bytes
from hindsight_api.engine.memories.postgres import fq_store_table
from hindsight_api.migrations import run_migrations


@pytest.mark.asyncio
async def test_bank_storage_bytes_includes_audit_logs_and_invalidated_memories(pg0_db_url):
    """``audit_log`` and ``invalidated_memory_units`` rows (including TOASTed bodies) are counted."""
    db_url = os.getenv("HINDSIGHT_API_DATABASE_URL") or pg0_db_url

    if db_url.startswith("pg0://"):
        from hindsight_api.pg0 import resolve_database_url

        db_url = await resolve_database_url(db_url)

    run_migrations(db_url)

    bank_id = f"storage_audit_test_{uuid.uuid4().hex[:8]}"
    log_id = uuid.uuid4()
    invalidated_id = uuid.uuid4()
    large_payload = json.dumps({"blob": "x" * 6000})

    conn = await asyncpg.connect(db_url)
    try:
        empty = await bank_storage_bytes(conn=conn, fq_table=fq_store_table, bank_id=bank_id)
        assert empty["audit_logs"] == 0
        assert empty["invalidated_memories"] == 0
        assert empty["total"] == 0

        await conn.execute(
            """
            INSERT INTO audit_log (id, action, transport, bank_id, request, response, metadata)
            VALUES ($1, 'retain', 'http', $2, $3::jsonb, $4::jsonb, $5::jsonb)
            """,
            log_id,
            bank_id,
            large_payload,
            large_payload,
            json.dumps({"source": "storage-test"}),
        )
        await conn.execute(
            """
            INSERT INTO invalidated_memory_units (id, bank_id, text, fact_type)
            VALUES ($1, $2, $3, 'world')
            """,
            invalidated_id,
            bank_id,
            "x" * 6000,
        )

        populated = await bank_storage_bytes(conn=conn, fq_table=fq_store_table, bank_id=bank_id)
        assert populated["audit_logs"] > 0
        assert populated["invalidated_memories"] > 0
        assert populated["total"] == sum(v for k, v in populated.items() if k != "total")
        assert populated["total"] >= populated["audit_logs"] + populated["invalidated_memories"]
    finally:
        await conn.execute("DELETE FROM invalidated_memory_units WHERE bank_id = $1", bank_id)
        await conn.execute("DELETE FROM audit_log WHERE bank_id = $1", bank_id)
        await conn.close()
