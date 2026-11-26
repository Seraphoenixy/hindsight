"""Sync page upserts against the real migrated PostgreSQL constraints."""

import uuid

import asyncpg
import pytest

from hindsight_api.engine.sync_objects_codec import apply_object_payload, export_object_payload
from hindsight_api.engine.sync_service import synchronize_v3
from hindsight_api.models import RequestContext
from tests.test_sync_changelog_step1 import sync_schema  # noqa: F401
from tests.test_object_sync_e2e import _create_replica, relay_server  # noqa: F401


@pytest.mark.parametrize("kind", ["folder", "page"])
async def test_sync_page_can_be_inserted_repeated_and_updated(pg0_db_url, sync_schema, kind):  # noqa: F811
    page_id = uuid.uuid4().hex
    conn = await asyncpg.connect(pg0_db_url)
    try:
        for name in ["Original", "Original", "Updated"]:
            await apply_object_payload(
                conn,
                schema=sync_schema,
                object_type="knowledge_page",
                bank_id="bank-a",
                object_id=page_id,
                payload={"kind": kind, "name": name},
            )
        stored = await export_object_payload(
            conn, schema=sync_schema, object_type="knowledge_page", bank_id="bank-a", object_id=page_id
        )
        assert stored is not None
        assert stored["name"] == "Updated"
        assert stored["kind"] == kind
    finally:
        await conn.close()


async def test_empty_replica_pulls_page_hierarchy_through_relay(pg0_db_url, relay_server, tmp_path):  # noqa: F811
    relay_url, token, _ = relay_server
    source, source_schema = await _create_replica(pg0_db_url)
    target, target_schema = await _create_replica(pg0_db_url)
    try:
        parent = await source.create_page_folder("shared", "Parent", request_context=RequestContext())
        child = await source.create_page_folder(
            "shared", "Child", parent_id=parent["id"], request_context=RequestContext()
        )
        pushed = await synchronize_v3(
            database_url=pg0_db_url,
            schema=source_schema,
            relay_url=relay_url,
            token=token,
            state_dir=tmp_path / "source",
        )
        assert pushed.pushed_count >= 3
        for _ in range(2):
            pulled = await synchronize_v3(
                database_url=pg0_db_url,
                schema=target_schema,
                relay_url=relay_url,
                token=token,
                state_dir=tmp_path / "target",
            )
            assert pulled.status in {"synced", "idle"}
        conn = await asyncpg.connect(pg0_db_url)
        try:
            stored = await export_object_payload(
                conn, schema=target_schema, object_type="knowledge_page", bank_id="shared", object_id=child["id"]
            )
            assert stored is not None
            assert stored["name"] == "Child" and stored["parent_id"] == parent["id"]
        finally:
            await conn.close()
    finally:
        await source.close()
        await target.close()
        conn = await asyncpg.connect(pg0_db_url)
        try:
            for schema in [source_schema, target_schema]:
                await conn.execute(f'DROP SCHEMA "{schema}" CASCADE')
        finally:
            await conn.close()


async def test_sync_page_id_collision_cannot_overwrite_another_bank(pg0_db_url, sync_schema):  # noqa: F811
    page_id = uuid.uuid4().hex
    conn = await asyncpg.connect(pg0_db_url)
    try:
        await apply_object_payload(
            conn,
            schema=sync_schema,
            object_type="knowledge_page",
            bank_id="bank-a",
            object_id=page_id,
            payload={"kind": "folder", "name": "Original"},
        )
        with pytest.raises(ValueError, match="belongs to another bank"):
            async with conn.transaction():
                await apply_object_payload(
                    conn,
                    schema=sync_schema,
                    object_type="knowledge_page",
                    bank_id="bank-b",
                    object_id=page_id,
                    payload={"kind": "folder", "name": "Overwrite"},
                )
        stored = await export_object_payload(
            conn, schema=sync_schema, object_type="knowledge_page", bank_id="bank-a", object_id=page_id
        )
        assert stored is not None and stored["name"] == "Original"
        assert (
            await export_object_payload(
                conn, schema=sync_schema, object_type="knowledge_page", bank_id="bank-b", object_id=page_id
            )
            is None
        )
    finally:
        await conn.close()
