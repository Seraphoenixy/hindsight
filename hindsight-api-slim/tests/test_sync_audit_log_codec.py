"""Unit tests for audit_log v3 object sync codec and ordering."""

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from hindsight_api.engine.sync_journal import APPLY_ORDER
from hindsight_api.engine.sync_objects_codec import (
    _list_audit_log_keys,
    apply_object_payload,
    delete_object_payload,
    export_object_payload,
)


def test_audit_log_in_apply_order():
    assert "audit_log" in APPLY_ORDER
    assert APPLY_ORDER["audit_log"] > APPLY_ORDER["bank"]


@pytest.mark.asyncio
async def test_audit_log_codec_list_export_apply_delete():
    uid = str(uuid.uuid4())
    now = datetime(2026, 11, 26, 12, 0, tzinfo=timezone.utc)

    conn = AsyncMock()
    conn.fetch.return_value = [{"id": uid, "bank_id": "bank-1"}]
    audit_keys = await _list_audit_log_keys(conn, "public")
    assert len(audit_keys) == 1
    assert audit_keys[0].bank_id == "bank-1"
    assert audit_keys[0].object_id == uid

    conn.fetchrow.return_value = {
        "id": uid,
        "action": "recall",
        "transport": "http",
        "bank_id": "bank-1",
        "started_at": now,
        "ended_at": now,
        "request": {"query": "hello"},
        "response": {"results": []},
        "metadata": {"source": "test"},
    }
    exported = await export_object_payload(
        conn, object_type="audit_log", bank_id="bank-1", object_id=uid, schema="public"
    )
    assert exported is not None
    assert exported["action"] == "recall"
    assert exported["request"] == {"query": "hello"}
    assert exported["metadata"] == {"source": "test"}

    await apply_object_payload(
        conn, object_type="audit_log", bank_id="bank-1", object_id=uid, payload=exported, schema="public"
    )
    apply_sql = conn.execute.call_args_list[-1].args[0]
    assert "INSERT INTO" in apply_sql and "audit_log" in apply_sql

    await delete_object_payload(conn, object_type="audit_log", bank_id="bank-1", object_id=uid, schema="public")
    delete_sql = conn.execute.call_args_list[-1].args[0]
    assert "DELETE FROM" in delete_sql and "audit_log" in delete_sql
