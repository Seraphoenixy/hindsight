"""Tests for archived memory (invalidated_memory_units) retention config and cleanup."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import asyncpg
import pytest

from hindsight_api.config import (
    DEFAULT_INVALIDATED_MEMORY_RETENTION_DAYS,
    ENV_INVALIDATED_MEMORY_RETENTION_DAYS,
    HindsightConfig,
)
from hindsight_api.engine.maintenance import MaintenanceLoop
from hindsight_api.engine.memories import get_memories
from hindsight_api.engine.memories.postgres import fq_store_table
from hindsight_api.migrations import run_migrations


def test_invalidated_memory_retention_config(monkeypatch):
    monkeypatch.delenv(ENV_INVALIDATED_MEMORY_RETENTION_DAYS, raising=False)
    monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
    cfg = HindsightConfig.from_env()
    assert cfg.invalidated_memory_retention_days == DEFAULT_INVALIDATED_MEMORY_RETENTION_DAYS
    assert cfg.invalidated_memory_retention_days == 7

    monkeypatch.setenv(ENV_INVALIDATED_MEMORY_RETENTION_DAYS, "0")
    assert HindsightConfig.from_env().invalidated_memory_retention_days == 0


@pytest.mark.asyncio
async def test_maintenance_run_retention_invokes_invalidated_memory_cleanup():
    loop = MaintenanceLoop(SimpleNamespace())
    loop._purge_expired = AsyncMock(return_value=0)
    loop._run_document_text_aging = AsyncMock(return_value=0)
    loop._run_invalidated_memory_cleanup = AsyncMock(return_value=0)

    cfg = SimpleNamespace(
        audit_log_retention_days=0,
        llm_trace_enabled=False,
        llm_trace_retention_days=0,
        document_text_retention_days=0,
        invalidated_memory_retention_days=30,
    )
    await loop._run_retention(cfg)
    loop._run_invalidated_memory_cleanup.assert_awaited_once_with(30)

    loop._run_invalidated_memory_cleanup.reset_mock()
    cfg.invalidated_memory_retention_days = 0
    await loop._run_retention(cfg)
    loop._run_invalidated_memory_cleanup.assert_not_awaited()


@pytest.mark.asyncio
async def test_prune_expired_invalidated_memories_postgres():
    db_url = os.getenv("HINDSIGHT_API_DATABASE_URL")
    if not db_url:
        pytest.skip("HINDSIGHT_API_DATABASE_URL not set")

    if db_url.startswith("pg0://"):
        from hindsight_api.pg0 import resolve_database_url

        db_url = await resolve_database_url(db_url)

    run_migrations(db_url)

    bank_id = f"inv_prune_test_{uuid.uuid4().hex[:8]}"
    old_id = uuid.uuid4()
    new_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    old_ts = now - timedelta(days=45)
    new_ts = now - timedelta(days=5)
    cutoff = now - timedelta(days=30)

    conn = await asyncpg.connect(db_url)
    store = get_memories()
    try:
        await conn.execute(
            "INSERT INTO banks (bank_id, name) VALUES ($1, $2) ON CONFLICT (bank_id) DO NOTHING",
            bank_id,
            bank_id,
        )
        arch = fq_store_table("invalidated_memory_units")
        await conn.execute(
            f"""
            INSERT INTO {arch} (id, bank_id, text, fact_type, invalidated_at, invalidation_reason)
            VALUES ($1, $2, 'old archived', 'world', $3, 'expired'),
                   ($4, $2, 'recent archived', 'world', $5, 'recent')
            """,
            old_id,
            bank_id,
            old_ts,
            new_id,
            new_ts,
        )

        pruned = await store.prune_expired_invalidated_memories(conn=conn, cutoff=cutoff, batch_size=500)
        assert pruned == 1

        remaining = await conn.fetch(f"SELECT id FROM {arch} WHERE bank_id = $1", bank_id)
        assert [r["id"] for r in remaining] == [new_id]
    finally:
        await conn.execute("DELETE FROM invalidated_memory_units WHERE bank_id = $1", bank_id)
        await conn.execute("DELETE FROM banks WHERE bank_id = $1", bank_id)
        await conn.close()
