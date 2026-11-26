"""PostgreSQL integration tests for Step 1: local change log, tombstones, and object codec."""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest
import pytest_asyncio

from hindsight_api import MemoryEngine, RequestContext
from hindsight_api.engine.cross_encoder import CrossEncoderModel
from hindsight_api.engine.db_utils import acquire_with_retry
from hindsight_api.engine.embeddings import Embeddings
from hindsight_api.engine.query_analyzer import DateparserQueryAnalyzer
from hindsight_api.engine.sync_journal import (
    fetch_pending_changes,
    get_local_high_water,
    get_object_state,
    mark_sync_applying,
)
from hindsight_api.engine.sync_objects_codec import (
    apply_object_payload,
    delete_object_payload,
    export_object_payload,
    list_all_object_keys,
)
from hindsight_api.engine.task_backend import SyncTaskBackend
from hindsight_api.engine.working_rules import WorkingRulesService
from hindsight_api.extensions.builtin.tenant import DefaultTenantExtension
from hindsight_api.migrations import run_migrations


class _StubEmbeddings(Embeddings):
    model_name = "stub-384"

    @property
    def provider_name(self) -> str:
        return "stub"

    @property
    def dimension(self) -> int:
        return 384

    async def initialize(self) -> None:
        return None

    async def encode(self, texts: list[str]) -> list[list[float]]:
        return [[0.01] * 384 for _ in texts]


class _StubCrossEncoder(CrossEncoderModel):
    @property
    def provider_name(self) -> str:
        return "stub"

    async def initialize(self) -> None:
        return None

    async def _predict(self, pairs: list[tuple[str, str]]) -> list[float]:
        return [0.5 for _ in pairs]


@pytest_asyncio.fixture
async def sync_schema(pg0_db_url: str):
    schema = f"test_sync_{uuid.uuid4().hex[:12]}"
    conn = await asyncpg.connect(pg0_db_url)
    try:
        await conn.execute(f'CREATE SCHEMA "{schema}"')
        try:
            await asyncio.to_thread(run_migrations, pg0_db_url, schema=schema)
            yield schema
        finally:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def sync_memory(pg0_db_url: str, sync_schema: str):
    mem = MemoryEngine(
        db_url=pg0_db_url,
        memory_llm_provider="mock",
        memory_llm_api_key="mock-key",
        memory_llm_model="mock-model",
        embeddings=_StubEmbeddings(),
        cross_encoder=_StubCrossEncoder(),
        query_analyzer=DateparserQueryAnalyzer(),
        tenant_extension=DefaultTenantExtension({"schema": sync_schema}),
        pool_min_size=1,
        pool_max_size=5,
        run_migrations=False,
        task_backend=SyncTaskBackend(),
    )
    await mem.initialize()
    try:
        yield mem
    finally:
        await mem.close()


@pytest.mark.asyncio
async def test_working_rule_and_document_changelog_recording(sync_memory: MemoryEngine, sync_schema: str):
    rc = RequestContext()
    rules = WorkingRulesService(sync_memory)
    backend = await sync_memory._get_backend()

    async with acquire_with_retry(backend) as conn:
        hwm0 = await get_local_high_water(conn, schema=sync_schema)

    # 1. Working rule add -> replace -> remove
    added = await rules.mutate_working_rule(
        action="add",
        content="Always keep unit tests deterministic.",
        importance="normal",
        request_context=rc,
    )
    assert added.rule is not None
    rule_id = added.rule.id

    replaced = await rules.mutate_working_rule(
        action="replace",
        old_text="Always keep unit tests deterministic.",
        content="Always keep unit tests deterministic and fast.",
        request_context=rc,
    )
    assert replaced.rule is not None

    # 2. Document retain -> update tags -> curate fact (invalidate + revert) -> delete
    bank_id = f"bank-{uuid.uuid4().hex[:8]}"
    await sync_memory.retain_batch_async(
        bank_id=bank_id,
        contents=[{"content": "Alice bought a green bicycle in Berlin on Tuesday.", "document_id": "doc-1"}],
        request_context=rc,
    )

    doc_updated = await sync_memory.update_document(
        document_id="doc-1",
        bank_id=bank_id,
        tags=["project:alpha"],
        request_context=rc,
    )
    assert doc_updated is True

    async with acquire_with_retry(backend) as conn:
        hwm1 = await get_local_high_water(conn, schema=sync_schema)
        assert hwm1 > hwm0

        wr_state = await get_object_state(
            conn, object_type="working_rule", bank_id="", object_id=rule_id, schema=sync_schema
        )
        assert wr_state is not None
        assert wr_state.version == 2
        assert wr_state.deleted is False
        exported_wr = await export_object_payload(
            conn, object_type="working_rule", bank_id="", object_id=rule_id, schema=sync_schema
        )
        assert exported_wr is not None
        assert exported_wr["content"] == "Always keep unit tests deterministic and fast."

        doc_state = await get_object_state(
            conn, object_type="document", bank_id=bank_id, object_id="doc-1", schema=sync_schema
        )
        assert doc_state is not None
        assert doc_state.deleted is False

        changes = await fetch_pending_changes(conn, after_seq=hwm0, limit=100, schema=sync_schema)
        assert any(c.object_type == "working_rule" and c.object_id == rule_id and c.op == "upsert" for c in changes)
        doc_changes = [
            c for c in changes if c.object_type == "document" and c.object_id == "doc-1" and c.op == "upsert"
        ]
        assert doc_changes
        exported_doc = await export_object_payload(
            conn, object_type="document", bank_id=bank_id, object_id="doc-1", schema=sync_schema
        )
        assert exported_doc is not None
        assert "project:alpha" in exported_doc["tags"]

        # Round-trip codec export
        exported_doc = await export_object_payload(
            conn, object_type="document", bank_id=bank_id, object_id="doc-1", schema=sync_schema
        )
        assert exported_doc is not None
        assert exported_doc["tags"] == ["project:alpha"]

        all_keys = await list_all_object_keys(conn, schema=sync_schema)
        assert any(k.object_type == "working_rule" and k.object_id == rule_id for k in all_keys)
        assert any(k.object_type == "document" and k.bank_id == bank_id and k.object_id == "doc-1" for k in all_keys)

    # 3. Delete working rule and delete document -> tombstones persisted
    await rules.mutate_working_rule(
        action="remove",
        old_text="Always keep unit tests deterministic and fast.",
        request_context=rc,
    )
    del_doc = await sync_memory.delete_document("doc-1", bank_id=bank_id, request_context=rc)
    assert del_doc["document_deleted"] == 1

    async with acquire_with_retry(backend) as conn:
        wr_del = await get_object_state(
            conn, object_type="working_rule", bank_id="", object_id=rule_id, schema=sync_schema
        )
        doc_del = await get_object_state(
            conn, object_type="document", bank_id=bank_id, object_id="doc-1", schema=sync_schema
        )
        assert wr_del is not None and wr_del.deleted is True and wr_del.version == 3
        assert doc_del is not None and doc_del.deleted is True

        # 4. Suppress triggers while applying remote objects
        hwm_before_apply = await get_local_high_water(conn, schema=sync_schema)
        async with conn.transaction():
            await mark_sync_applying(conn)
            await apply_object_payload(
                conn,
                object_type="working_rule",
                bank_id="",
                object_id=rule_id,
                payload=exported_wr,
                schema=sync_schema,
            )
            await delete_object_payload(
                conn, object_type="working_rule", bank_id="", object_id=rule_id, schema=sync_schema
            )
        hwm_after_apply = await get_local_high_water(conn, schema=sync_schema)
        assert hwm_after_apply == hwm_before_apply
