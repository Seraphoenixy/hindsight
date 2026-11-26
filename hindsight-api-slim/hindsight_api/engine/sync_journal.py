"""Transactional change log, causal object state, cursors, and conflict audit records."""

from __future__ import annotations

import getpass
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, field_validator

from ..schema_context import get_current_schema
from .schema import fq_table_explicit


def _tbl(name: str, schema: str | None) -> str:
    return fq_table_explicit(name, schema or get_current_schema())


ObjectType = Literal[
    "working_rule",
    "bank",
    "directive",
    "document",
    "memory_unit",
    "observation",
    "mental_model",
    "knowledge_page",
    "kb_document",
    "webhook",
]
ChangeOp = Literal["upsert", "delete", "restore"]
ConflictSide = Literal["local", "remote"]

# Dependency order when applying an incoming batch inside one PostgreSQL transaction.
# Parents always precede children; knowledge_page is further topologically sorted
# so parent folders precede child folders/pages.
APPLY_ORDER: dict[str, int] = {
    "working_rule": 10,
    "bank": 20,
    "directive": 30,
    "document": 40,
    "memory_unit": 50,
    "observation": 60,
    "mental_model": 70,
    "knowledge_page": 80,
    "kb_document": 90,
    "webhook": 100,
}


def _ensure_utc(value: Any) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _ensure_optional_utc(value: Any) -> datetime | None:
    if value is None:
        return None
    return _ensure_utc(value)


def iso_utc(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    return str(value)


def parse_json_value(conn: Any, value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        return json.loads(value)
    if hasattr(conn, "parse_json"):
        return conn.parse_json(value)
    return value


def vec_literal(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "[" + ",".join(str(float(x)) for x in value) + "]"
    return str(value)


def canonical_json(data: Any) -> str:
    """Deterministic UTF-8 JSON representation for hashing and conflict comparison."""
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def compute_content_hash(payload: dict[str, Any] | None, *, deleted: bool = False) -> str:
    """Compute a deterministic SHA-256 digest of a canonical object payload."""
    if deleted or payload is None:
        return "deleted"
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


class SyncChangeEntry(BaseModel):
    """A single ordered local change-log entry."""

    seq: int
    object_type: str
    bank_id: str = ""
    object_id: str
    op: ChangeOp
    version: int
    base_relay_version: int = 0
    content_hash: str = ""
    payload: dict[str, Any] | None = None
    origin_device_id: str | None = None
    created_at: datetime

    @field_validator("created_at", mode="before")
    @classmethod
    def _tz_created(cls, v: Any) -> datetime:
        return _ensure_utc(v)


class SyncObjectStateRecord(BaseModel):
    """Current causal state of one synced object in local PostgreSQL."""

    object_type: str
    bank_id: str = ""
    object_id: str
    version: int
    base_relay_version: int = 0
    content_hash: str = ""
    deleted: bool = False
    deleted_at: datetime | None = None
    dirty: bool = True
    last_seq: int = 0
    origin_device_id: str | None = None
    last_synced_hash: str | None = None
    last_synced_payload: dict[str, Any] | None = None
    updated_at: datetime

    @field_validator("updated_at", mode="before")
    @classmethod
    def _tz_updated(cls, v: Any) -> datetime:
        return _ensure_utc(v)

    @field_validator("deleted_at", mode="before")
    @classmethod
    def _tz_deleted(cls, v: Any) -> datetime | None:
        return _ensure_optional_utc(v)


class SyncCursorRecord(BaseModel):
    """Per-replica upload/download sync cursor and authentication status."""

    replica_id: str
    relay_url: str
    schema_name: str
    device_id: str = ""
    relay_epoch: str = ""
    out_seq: int = 0
    in_seq: int = 0
    joined: bool = False
    auth_status: str = "ok"
    last_error: str | None = None
    last_synced_at: datetime | None = None
    updated_at: datetime

    @field_validator("updated_at", mode="before")
    @classmethod
    def _tz_updated(cls, v: Any) -> datetime:
        return _ensure_utc(v)

    @field_validator("last_synced_at", mode="before")
    @classmethod
    def _tz_synced(cls, v: Any) -> datetime | None:
        return _ensure_optional_utc(v)


class SyncConflictConfirmation(BaseModel):
    """Audit confirmation metadata for a resolved object conflict."""

    at: datetime
    by: str
    note: str | None = None

    @field_validator("at", mode="before")
    @classmethod
    def _tz_at(cls, v: Any) -> datetime:
        return _ensure_utc(v)


class SyncObjectConflictRecord(BaseModel):
    """Per-object sync conflict audit record persisted before applying auto-resolution."""

    id: str
    kind: Literal["object"] = "object"
    detected_at: datetime
    object_type: str
    bank_id: str = ""
    object_id: str
    resolution: ConflictSide
    automatic: bool
    base_version: int | None = None
    local_version: int
    remote_version: int
    local_device_id: str = ""
    remote_device_id: str = ""
    local_content_hash: str = ""
    remote_content_hash: str = ""
    local_payload: dict[str, Any] | None = None
    remote_payload: dict[str, Any] | None = None
    applied_version: int | None = None
    applied_at: datetime | None = None
    confirmation: SyncConflictConfirmation | None = None
    restored_at: datetime | None = None
    restored_by: str | None = None
    restored_side: ConflictSide | None = None
    restored_version: int | None = None

    @field_validator("detected_at", mode="before")
    @classmethod
    def _tz_detected(cls, v: Any) -> datetime:
        return _ensure_utc(v)

    @field_validator("applied_at", "restored_at", mode="before")
    @classmethod
    def _tz_opt(cls, v: Any) -> datetime | None:
        return _ensure_optional_utc(v)


class SyncConflictPage(BaseModel):
    """Paginated list of object sync conflict records."""

    items: list[SyncObjectConflictRecord]
    total: int
    limit: int
    offset: int


class RecordedChangeResult(BaseModel):
    """Result of recording a local sync change inside a business transaction."""

    seq: int
    version: int
    op: ChangeOp
    content_hash: str


def _parse_json_col(conn: Any, value: Any) -> dict[str, Any] | None:
    parsed = parse_json_value(conn, value)
    return parsed if isinstance(parsed, dict) else None


def _is_pg_conn(conn: Any) -> bool:
    return getattr(conn, "backend_type", "postgresql") != "oracle"


async def mark_sync_tx_managed(conn: Any) -> None:
    """Suppress row-level fallback triggers when the caller logs the canonical change itself."""
    if _is_pg_conn(conn):
        await conn.execute("SET LOCAL hindsight.sync_tx_managed = '1'")


async def mark_sync_applying(conn: Any) -> None:
    """Suppress change-log capture while applying changes received from the relay."""
    if _is_pg_conn(conn):
        await conn.execute("SET LOCAL hindsight.sync_applying = '1'")


async def record_sync_change(
    conn: Any,
    *,
    object_type: str,
    bank_id: str,
    object_id: str,
    op: ChangeOp,
    payload: dict[str, Any] | None = None,
    content_hash: str | None = None,
    origin_device_id: str | None = None,
    schema: str | None = None,
) -> RecordedChangeResult | None:
    """Record a local object mutation inside the caller's active transaction.

    Maintains causal version numbers, deletion tombstones, and the ordered
    ``sync_change_log``. Safe to call on PostgreSQL; no-op on Oracle.
    """
    if not _is_pg_conn(conn):
        return None

    # Check if sync tables exist yet (early test schemas or pre-migration runs).
    state_table = _tbl("sync_object_state", schema)
    log_table = _tbl("sync_change_log", schema)
    if await conn.fetchval("SELECT to_regclass($1)", state_table) is None:
        return None

    effective_deleted = op == "delete"
    digest = content_hash or compute_content_hash(payload, deleted=effective_deleted)
    payload_json = json.dumps(payload, ensure_ascii=False, default=str) if payload is not None else None

    existing = await conn.fetchrow(
        f"SELECT version, base_relay_version, deleted FROM {state_table} "
        f"WHERE object_type = $1 AND bank_id = $2 AND object_id = $3 FOR UPDATE",
        object_type,
        bank_id,
        object_id,
    )
    effective_op: ChangeOp = op
    if existing is not None and bool(existing["deleted"]) and not effective_deleted:
        # Re-creating or explicitly restoring a tombstoned object must produce a
        # fresh causal version marked as 'restore' so older deletes do not suppress it.
        effective_op = "restore"

    row = await conn.fetchrow(
        f"""
        INSERT INTO {state_table} (
            object_type, bank_id, object_id, version, base_relay_version,
            content_hash, deleted, deleted_at, dirty, origin_device_id, updated_at
        )
        VALUES ($1, $2, $3, 1, 0, $4, $5, CASE WHEN $5 THEN now() ELSE NULL END, TRUE, $6, now())
        ON CONFLICT (object_type, bank_id, object_id) DO UPDATE
        SET version = {state_table}.version + 1,
            content_hash = EXCLUDED.content_hash,
            deleted = EXCLUDED.deleted,
            deleted_at = CASE WHEN EXCLUDED.deleted THEN now() ELSE NULL END,
            dirty = TRUE,
            origin_device_id = EXCLUDED.origin_device_id,
            updated_at = now()
        RETURNING version, base_relay_version
        """,
        object_type,
        bank_id,
        object_id,
        digest,
        effective_deleted,
        origin_device_id,
    )
    new_version = int(row["version"])
    base_relay_version = int(row["base_relay_version"])

    seq = await conn.fetchval(
        f"""
        INSERT INTO {log_table} (
            object_type, bank_id, object_id, op, version,
            base_relay_version, content_hash, payload, origin_device_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        RETURNING seq
        """,
        object_type,
        bank_id,
        object_id,
        effective_op,
        new_version,
        base_relay_version,
        digest,
        payload_json,
        origin_device_id,
    )
    seq_int = int(seq)
    await conn.execute(
        f"UPDATE {state_table} SET last_seq = $4 WHERE object_type = $1 AND bank_id = $2 AND object_id = $3",
        object_type,
        bank_id,
        object_id,
        seq_int,
    )
    return RecordedChangeResult(seq=seq_int, version=new_version, op=effective_op, content_hash=digest)


async def get_local_high_water(conn: Any, *, schema: str | None = None) -> int:
    """Return the monotonic local change-log high-water sequence."""
    log_table = _tbl("sync_change_log", schema)
    val = await conn.fetchval(f"SELECT COALESCE(MAX(seq), 0) FROM {log_table}")
    return int(val or 0)


async def get_object_state(
    conn: Any,
    *,
    object_type: str,
    bank_id: str,
    object_id: str,
    schema: str | None = None,
    for_update: bool = False,
) -> SyncObjectStateRecord | None:
    """Fetch the current causal sync state of a single object."""
    state_table = _tbl("sync_object_state", schema)
    lock = " FOR UPDATE" if for_update else ""
    row = await conn.fetchrow(
        f"""
        SELECT object_type, bank_id, object_id, version, base_relay_version,
               content_hash, deleted, deleted_at, dirty, last_seq,
               origin_device_id, last_synced_hash, last_synced_payload, updated_at
        FROM {state_table}
        WHERE object_type = $1 AND bank_id = $2 AND object_id = $3{lock}
        """,
        object_type,
        bank_id,
        object_id,
    )
    if row is None:
        return None
    return SyncObjectStateRecord(
        object_type=row["object_type"],
        bank_id=row["bank_id"],
        object_id=row["object_id"],
        version=int(row["version"]),
        base_relay_version=int(row["base_relay_version"]),
        content_hash=row["content_hash"],
        deleted=bool(row["deleted"]),
        deleted_at=row["deleted_at"],
        dirty=bool(row["dirty"]),
        last_seq=int(row["last_seq"]),
        origin_device_id=row["origin_device_id"],
        last_synced_hash=row["last_synced_hash"],
        last_synced_payload=_parse_json_col(conn, row["last_synced_payload"]),
        updated_at=row["updated_at"],
    )


async def mark_object_synced(
    conn: Any,
    *,
    object_type: str,
    bank_id: str,
    object_id: str,
    relay_version: int,
    content_hash: str,
    deleted: bool,
    payload: dict[str, Any] | None,
    origin_device_id: str | None,
    expected_last_seq: int | None = None,
    schema: str | None = None,
) -> None:
    """Record that an object reached consensus with the relay at ``relay_version``.

    If ``expected_last_seq`` is supplied and the local object was modified again
    since that snapshot (``last_seq > expected_last_seq``), ``dirty`` stays TRUE
    and ``base_relay_version`` advances so the newer local edit merges cleanly on
    the next cycle instead of being lost.
    """
    state_table = _tbl("sync_object_state", schema)
    payload_json = json.dumps(payload, ensure_ascii=False, default=str) if payload is not None else None
    existing = await conn.fetchrow(
        f"SELECT version, last_seq FROM {state_table} "
        f"WHERE object_type = $1 AND bank_id = $2 AND object_id = $3 FOR UPDATE",
        object_type,
        bank_id,
        object_id,
    )
    if existing is None:
        await conn.execute(
            f"""
            INSERT INTO {state_table} (
                object_type, bank_id, object_id, version, base_relay_version,
                content_hash, deleted, deleted_at, dirty, last_seq,
                origin_device_id, last_synced_hash, last_synced_payload, updated_at
            )
            VALUES (
                $1, $2, $3, $4, $4, $5, $6, CASE WHEN $6 THEN now() ELSE NULL END,
                FALSE, 0, $7, $5, $8::jsonb, now()
            )
            """,
            object_type,
            bank_id,
            object_id,
            max(relay_version, 1),
            content_hash,
            deleted,
            origin_device_id,
            payload_json,
        )
        return

    concurrent_local_edit = expected_last_seq is not None and int(existing["last_seq"]) > expected_last_seq
    if concurrent_local_edit:
        await conn.execute(
            f"""
            UPDATE {state_table}
            SET base_relay_version = $4,
                last_synced_hash = $5,
                last_synced_payload = $6::jsonb,
                updated_at = now()
            WHERE object_type = $1 AND bank_id = $2 AND object_id = $3
            """,
            object_type,
            bank_id,
            object_id,
            relay_version,
            content_hash,
            payload_json,
        )
    else:
        await conn.execute(
            f"""
            UPDATE {state_table}
            SET version = GREATEST(version, $4),
                base_relay_version = $4,
                content_hash = $5,
                deleted = $6,
                deleted_at = CASE WHEN $6 THEN COALESCE(deleted_at, now()) ELSE NULL END,
                dirty = FALSE,
                origin_device_id = $7,
                last_synced_hash = $5,
                last_synced_payload = $8::jsonb,
                updated_at = now()
            WHERE object_type = $1 AND bank_id = $2 AND object_id = $3
            """,
            object_type,
            bank_id,
            object_id,
            relay_version,
            content_hash,
            deleted,
            origin_device_id,
            payload_json,
        )


async def fetch_pending_changes(
    conn: Any,
    *,
    after_seq: int,
    limit: int = 200,
    schema: str | None = None,
) -> list[SyncChangeEntry]:
    """Read local changes strictly after ``after_seq`` ordered by ``seq ASC``."""
    log_table = _tbl("sync_change_log", schema)
    rows = await conn.fetch(
        f"""
        SELECT seq, object_type, bank_id, object_id, op, version,
               base_relay_version, content_hash, payload, origin_device_id, created_at
        FROM {log_table}
        WHERE seq > $1
        ORDER BY seq ASC
        LIMIT $2
        """,
        after_seq,
        limit,
    )
    return [
        SyncChangeEntry(
            seq=int(row["seq"]),
            object_type=row["object_type"],
            bank_id=row["bank_id"],
            object_id=row["object_id"],
            op=row["op"],
            version=int(row["version"]),
            base_relay_version=int(row["base_relay_version"]),
            content_hash=row["content_hash"],
            payload=_parse_json_col(conn, row["payload"]),
            origin_device_id=row["origin_device_id"],
            created_at=row["created_at"],
        )
        for row in rows
    ]


async def get_sync_cursor(conn: Any, replica_id: str, *, schema: str | None = None) -> SyncCursorRecord | None:
    """Read the persisted sync cursor for ``replica_id``."""
    table = _tbl("sync_cursors", schema)
    row = await conn.fetchrow(
        f"""
        SELECT replica_id, relay_url, schema_name, device_id, relay_epoch,
               out_seq, in_seq, joined, auth_status, last_error, last_synced_at, updated_at
        FROM {table}
        WHERE replica_id = $1
        """,
        replica_id,
    )
    if row is None:
        return None
    return SyncCursorRecord(
        replica_id=row["replica_id"],
        relay_url=row["relay_url"],
        schema_name=row["schema_name"],
        device_id=row["device_id"],
        relay_epoch=row["relay_epoch"],
        out_seq=int(row["out_seq"]),
        in_seq=int(row["in_seq"]),
        joined=bool(row["joined"]),
        auth_status=row["auth_status"],
        last_error=row["last_error"],
        last_synced_at=row["last_synced_at"],
        updated_at=row["updated_at"],
    )


async def upsert_sync_cursor(
    conn: Any,
    cursor: SyncCursorRecord,
    *,
    schema: str | None = None,
) -> SyncCursorRecord:
    """Persist updated cursor fields atomically."""
    table = _tbl("sync_cursors", schema)
    row = await conn.fetchrow(
        f"""
        INSERT INTO {table} (
            replica_id, relay_url, schema_name, device_id, relay_epoch,
            out_seq, in_seq, joined, auth_status, last_error, last_synced_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
        ON CONFLICT (replica_id) DO UPDATE
        SET relay_url = EXCLUDED.relay_url,
            schema_name = EXCLUDED.schema_name,
            device_id = EXCLUDED.device_id,
            relay_epoch = EXCLUDED.relay_epoch,
            out_seq = EXCLUDED.out_seq,
            in_seq = EXCLUDED.in_seq,
            joined = EXCLUDED.joined,
            auth_status = EXCLUDED.auth_status,
            last_error = EXCLUDED.last_error,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = now()
        RETURNING replica_id, relay_url, schema_name, device_id, relay_epoch,
                  out_seq, in_seq, joined, auth_status, last_error, last_synced_at, updated_at
        """,
        cursor.replica_id,
        cursor.relay_url,
        cursor.schema_name,
        cursor.device_id,
        cursor.relay_epoch,
        cursor.out_seq,
        cursor.in_seq,
        cursor.joined,
        cursor.auth_status,
        cursor.last_error,
        cursor.last_synced_at,
    )
    return SyncCursorRecord(
        replica_id=row["replica_id"],
        relay_url=row["relay_url"],
        schema_name=row["schema_name"],
        device_id=row["device_id"],
        relay_epoch=row["relay_epoch"],
        out_seq=int(row["out_seq"]),
        in_seq=int(row["in_seq"]),
        joined=bool(row["joined"]),
        auth_status=row["auth_status"],
        last_error=row["last_error"],
        last_synced_at=row["last_synced_at"],
        updated_at=row["updated_at"],
    )


def _row_to_conflict(conn: Any, row: Any) -> SyncObjectConflictRecord:
    confirmation = (
        SyncConflictConfirmation(
            at=row["confirmation_at"],
            by=row["confirmation_by"],
            note=row["confirmation_note"],
        )
        if row["confirmation_at"] is not None
        else None
    )
    return SyncObjectConflictRecord(
        id=row["id"],
        detected_at=row["detected_at"],
        object_type=row["object_type"],
        bank_id=row["bank_id"],
        object_id=row["object_id"],
        resolution=row["resolution"],
        automatic=bool(row["automatic"]),
        base_version=int(row["base_version"]) if row["base_version"] is not None else None,
        local_version=int(row["local_version"]),
        remote_version=int(row["remote_version"]),
        local_device_id=row["local_device_id"],
        remote_device_id=row["remote_device_id"],
        local_content_hash=row["local_content_hash"],
        remote_content_hash=row["remote_content_hash"],
        local_payload=_parse_json_col(conn, row["local_payload"]),
        remote_payload=_parse_json_col(conn, row["remote_payload"]),
        applied_version=int(row["applied_version"]) if row["applied_version"] is not None else None,
        applied_at=row["applied_at"],
        confirmation=confirmation,
        restored_at=row["restored_at"],
        restored_by=row["restored_by"],
        restored_side=row["restored_side"],
        restored_version=int(row["restored_version"]) if row["restored_version"] is not None else None,
    )


async def insert_sync_conflict(
    conn: Any,
    *,
    object_type: str,
    bank_id: str,
    object_id: str,
    resolution: ConflictSide,
    automatic: bool,
    base_version: int | None,
    local_version: int,
    remote_version: int,
    local_device_id: str,
    remote_device_id: str,
    local_content_hash: str,
    remote_content_hash: str,
    local_payload: dict[str, Any] | None,
    remote_payload: dict[str, Any] | None,
    schema: str | None = None,
) -> SyncObjectConflictRecord:
    """Persist an object conflict record before applying the automatic resolution."""
    table = _tbl("sync_conflicts", schema)
    conflict_id = uuid.uuid4().hex
    row = await conn.fetchrow(
        f"""
        INSERT INTO {table} (
            id, detected_at, object_type, bank_id, object_id, resolution, automatic,
            base_version, local_version, remote_version, local_device_id, remote_device_id,
            local_content_hash, remote_content_hash, local_payload, remote_payload
        )
        VALUES (
            $1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb
        )
        RETURNING *
        """,
        conflict_id,
        object_type,
        bank_id,
        object_id,
        resolution,
        automatic,
        base_version,
        local_version,
        remote_version,
        local_device_id,
        remote_device_id,
        local_content_hash,
        remote_content_hash,
        json.dumps(local_payload, ensure_ascii=False, default=str) if local_payload is not None else None,
        json.dumps(remote_payload, ensure_ascii=False, default=str) if remote_payload is not None else None,
    )
    return _row_to_conflict(conn, row)


async def mark_sync_conflict_applied(
    conn: Any,
    conflict_id: str,
    *,
    applied_version: int,
    schema: str | None = None,
) -> SyncObjectConflictRecord | None:
    """Stamp the applied version once the winning side commits."""
    table = _tbl("sync_conflicts", schema)
    row = await conn.fetchrow(
        f"""
        UPDATE {table}
        SET applied_version = $2, applied_at = now()
        WHERE id = $1
        RETURNING *
        """,
        conflict_id,
        applied_version,
    )
    return _row_to_conflict(conn, row) if row is not None else None


async def list_sync_conflicts(
    conn: Any,
    *,
    limit: int = 100,
    offset: int = 0,
    unconfirmed_only: bool = False,
    schema: str | None = None,
) -> SyncConflictPage:
    """List paginated per-object conflict records ordered newest first."""
    table = _tbl("sync_conflicts", schema)
    where = "WHERE confirmation_at IS NULL" if unconfirmed_only else ""
    total = int(await conn.fetchval(f"SELECT COUNT(*) FROM {table} {where}") or 0)
    if limit == 0:
        return SyncConflictPage(items=[], total=total, limit=limit, offset=offset)
    rows = await conn.fetch(
        f"""
        SELECT * FROM {table}
        {where}
        ORDER BY detected_at DESC, id DESC
        LIMIT $1 OFFSET $2
        """,
        limit,
        offset,
    )
    return SyncConflictPage(
        items=[_row_to_conflict(conn, r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


async def get_sync_conflict(
    conn: Any,
    conflict_id: str,
    *,
    schema: str | None = None,
) -> SyncObjectConflictRecord | None:
    """Read a single per-object conflict record by ID."""
    table = _tbl("sync_conflicts", schema)
    row = await conn.fetchrow(f"SELECT * FROM {table} WHERE id = $1", conflict_id)
    return _row_to_conflict(conn, row) if row is not None else None


async def confirm_sync_conflict(
    conn: Any,
    conflict_id: str,
    *,
    note: str | None = None,
    by: str | None = None,
    schema: str | None = None,
) -> SyncObjectConflictRecord | None:
    """Record operator confirmation on an object conflict (idempotent if already confirmed)."""
    table = _tbl("sync_conflicts", schema)
    existing = await get_sync_conflict(conn, conflict_id, schema=schema)
    if existing is None:
        return None
    if existing.confirmation is not None:
        return existing
    actor = by or getpass.getuser()
    row = await conn.fetchrow(
        f"""
        UPDATE {table}
        SET confirmation_at = now(), confirmation_by = $2, confirmation_note = $3
        WHERE id = $1
        RETURNING *
        """,
        conflict_id,
        actor,
        note,
    )
    return _row_to_conflict(conn, row) if row is not None else None


async def mark_sync_conflict_restored(
    conn: Any,
    conflict_id: str,
    *,
    side: ConflictSide,
    restored_version: int,
    note: str | None = None,
    by: str | None = None,
    schema: str | None = None,
) -> SyncObjectConflictRecord | None:
    """Mark a conflict record as restored (and confirm it if not already confirmed)."""
    table = _tbl("sync_conflicts", schema)
    actor = by or getpass.getuser()
    row = await conn.fetchrow(
        f"""
        UPDATE {table}
        SET restored_at = now(),
            restored_by = $2,
            restored_side = $3,
            restored_version = $4,
            confirmation_at = COALESCE(confirmation_at, now()),
            confirmation_by = COALESCE(confirmation_by, $2),
            confirmation_note = COALESCE(confirmation_note, $5)
        WHERE id = $1
        RETURNING *
        """,
        conflict_id,
        actor,
        side,
        restored_version,
        note,
    )
    return _row_to_conflict(conn, row) if row is not None else None


async def has_active_async_operations(conn: Any, *, schema: str | None = None) -> bool:
    """True when background operations are pending or running in this schema."""
    table = _tbl("async_operations", schema)
    return bool(await conn.fetchval(f"SELECT EXISTS (SELECT 1 FROM {table} WHERE status IN ('pending', 'processing'))"))
