"""Tests for manual audit log clearing via MemoryEngine.clear_audit_logs."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import pytest

from hindsight_api import RequestContext
from hindsight_api.engine.memory_engine import MemoryEngine
from hindsight_api.engine.sync_objects_codec import _apply_audit_log
from hindsight_api.migrations import run_migrations


@pytest.mark.asyncio
async def test_clear_audit_logs_supports_cutoff_and_full_clear():
    db_url = os.getenv("HINDSIGHT_API_DATABASE_URL")
    if not db_url:
        pytest.skip("HINDSIGHT_API_DATABASE_URL not set")

    if db_url.startswith("pg0://"):
        from hindsight_api.pg0 import resolve_database_url

        db_url = await resolve_database_url(db_url)

    run_migrations(db_url)

    bank_id = f"clear_audit_test_{uuid.uuid4().hex[:8]}"
    old_id = str(uuid.uuid4())
    new_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    old_ts = now - timedelta(days=10)
    cutoff = now - timedelta(days=5)

    conn = await asyncpg.connect(db_url)
    try:
        await conn.execute(
            "INSERT INTO banks (bank_id, name) VALUES ($1, $2) ON CONFLICT (bank_id) DO NOTHING",
            bank_id,
            bank_id,
        )
        await _apply_audit_log(
            conn,
            None,
            bank_id,
            old_id,
            {
                "id": old_id,
                "action": "retain",
                "transport": "http",
                "bank_id": bank_id,
                "started_at": old_ts.isoformat(),
                "metadata": {},
            },
        )
        await _apply_audit_log(
            conn,
            None,
            bank_id,
            new_id,
            {
                "id": new_id,
                "action": "recall",
                "transport": "http",
                "bank_id": bank_id,
                "started_at": now.isoformat(),
                "metadata": {},
            },
        )

        # Build a lightweight MemoryEngine bound to an asyncpg pool for clear_audit_logs.
        pool = await asyncpg.create_pool(db_url, min_size=1, max_size=2)
        try:
            engine = MemoryEngine.__new__(MemoryEngine)
            engine._pool = pool

            async def _fake_get_backend():
                return pool

            engine._get_backend = _fake_get_backend

            class _NoopCache:
                async def invalidate(self, *_args, **_kwargs):
                    return None

            engine._bank_stats_cache = _NoopCache()

            async def _fake_get_bank_profile(bid, *, request_context):
                return {"bank_id": bid}

            async def _fake_refuse(*_args, **_kwargs):
                return None

            engine.get_bank_profile = _fake_get_bank_profile
            engine._refuse_bank_wide_if_scoped = _fake_refuse

            res_before = await engine.clear_audit_logs(bank_id, request_context=RequestContext(), before=cutoff)
            assert res_before == {"deleted_count": 1}

            remaining = await conn.fetch("SELECT id::text AS id FROM audit_log WHERE bank_id = $1", bank_id)
            assert [r["id"] for r in remaining] == [new_id]

            res_all = await engine.clear_audit_logs(bank_id, request_context=RequestContext())
            assert res_all == {"deleted_count": 1}

            remaining_after = await conn.fetch("SELECT id::text AS id FROM audit_log WHERE bank_id = $1", bank_id)
            assert remaining_after == []
        finally:
            await pool.close()
    finally:
        await conn.execute("DELETE FROM audit_log WHERE bank_id = $1", bank_id)
        await conn.execute("DELETE FROM banks WHERE bank_id = $1", bank_id)
        await conn.close()
